import { Duration, Stack } from "aws-cdk-lib";
import * as budgets from "aws-cdk-lib/aws-budgets";
import * as cloudwatch from "aws-cdk-lib/aws-cloudwatch";
import * as cwActions from "aws-cdk-lib/aws-cloudwatch-actions";
import * as elbv2 from "aws-cdk-lib/aws-elasticloadbalancingv2";
import * as rds from "aws-cdk-lib/aws-rds";
import * as sns from "aws-cdk-lib/aws-sns";
import * as subscriptions from "aws-cdk-lib/aws-sns-subscriptions";
import { Construct } from "constructs";
import type { ProductService } from "./product-service";

export interface ObservabilityProps {
  readonly loadBalancer: elbv2.IApplicationLoadBalancer;
  readonly database: rds.DatabaseInstance;
  readonly services: ProductService[];

  /** Where alarms and budget warnings go. Requires confirming a subscription email. */
  readonly alarmEmail?: string;

  /** Monthly spend, in USD, that should trigger a warning. */
  readonly monthlyBudgetUsd: number;
}

/**
 * Metrics, a dashboard, alarms and a budget.
 *
 * The governing idea is that an alarm should correspond to something you would get up
 * and fix. Graphs are for understanding, alarms are for waking someone; conflating them
 * produces a wall of red that everybody learns to ignore, at which point the real one
 * is indistinguishable from the noise.
 *
 * So: a lot of widgets, and deliberately few alarms.
 */
export class Observability extends Construct {
  public readonly dashboard: cloudwatch.Dashboard;
  public readonly alarmTopic: sns.Topic;

  constructor(scope: Construct, id: string, props: ObservabilityProps) {
    super(scope, id);

    this.alarmTopic = new sns.Topic(this, "Alarms", {
      topicName: "aadyon-alarms",
      displayName: "Aadyon alarms",
    });
    if (props.alarmEmail) {
      this.alarmTopic.addSubscription(new subscriptions.EmailSubscription(props.alarmEmail));
    }
    const notify = new cwActions.SnsAction(this.alarmTopic);

    // ----------------------------------------------------------------- edge
    const alb = props.loadBalancer as elbv2.ApplicationLoadBalancer;

    const requests = alb.metrics.requestCount({ period: Duration.minutes(5) });
    const elb5xx = alb.metrics.httpCodeElb(elbv2.HttpCodeElb.ELB_5XX_COUNT, {
      period: Duration.minutes(5),
    });
    const target5xx = alb.metrics.httpCodeTarget(elbv2.HttpCodeTarget.TARGET_5XX_COUNT, {
      period: Duration.minutes(5),
    });

    // p99 alongside average, because an average hides exactly the requests users
    // complain about. A service can average 80 ms while one call in a hundred takes
    // four seconds, and only one of those numbers explains the complaint.
    const latencyAvg = alb.metrics.targetResponseTime({ period: Duration.minutes(5) });
    const latencyP99 = alb.metrics.targetResponseTime({
      period: Duration.minutes(5),
      statistic: "p99",
    });
    const latencyP50 = alb.metrics.targetResponseTime({
      period: Duration.minutes(5),
      statistic: "p50",
    });

    // ------------------------------------------------------------- dashboard
    this.dashboard = new cloudwatch.Dashboard(this, "Dashboard", {
      dashboardName: "aadyon",
      defaultInterval: Duration.hours(12),
    });

    this.dashboard.addWidgets(
      new cloudwatch.SingleValueWidget({
        title: "Now",
        width: 24,
        height: 3,
        metrics: [requests, elb5xx, target5xx, latencyP99],
      }),
    );

    this.dashboard.addWidgets(
      new cloudwatch.GraphWidget({
        title: "Requests",
        width: 12,
        left: [requests],
      }),
      new cloudwatch.GraphWidget({
        title: "Latency (s)",
        width: 12,
        left: [latencyP50, latencyAvg, latencyP99],
      }),
    );

    this.dashboard.addWidgets(
      new cloudwatch.GraphWidget({
        title: "Errors",
        width: 12,
        left: [
          elb5xx,
          target5xx,
          alb.metrics.httpCodeTarget(elbv2.HttpCodeTarget.TARGET_4XX_COUNT, {
            period: Duration.minutes(5),
          }),
        ],
      }),
      new cloudwatch.GraphWidget({
        title: "Healthy targets",
        width: 12,
        left: props.services.map((s) =>
          s.targetGroup.metrics.healthyHostCount({
            period: Duration.minutes(1),
            label: s.serviceName,
          }),
        ),
        right: props.services.map((s) =>
          s.targetGroup.metrics.unhealthyHostCount({
            period: Duration.minutes(1),
            label: `${s.serviceName} unhealthy`,
          }),
        ),
      }),
    );

    // ---------------------------------------------------------- per service
    for (const svc of props.services) {
      this.dashboard.addWidgets(
        new cloudwatch.GraphWidget({
          title: `${svc.serviceName}: CPU and memory (%)`,
          width: 12,
          left: [
            svc.service.metricCpuUtilization({ period: Duration.minutes(5), label: "cpu" }),
            svc.service.metricMemoryUtilization({ period: Duration.minutes(5), label: "memory" }),
          ],
          leftYAxis: { min: 0, max: 100 },
        }),
        new cloudwatch.GraphWidget({
          title: `${svc.serviceName}: response time (s)`,
          width: 12,
          left: [
            svc.targetGroup.metrics.targetResponseTime({
              period: Duration.minutes(5),
              statistic: "p50",
              label: "p50",
            }),
            svc.targetGroup.metrics.targetResponseTime({
              period: Duration.minutes(5),
              statistic: "p99",
              label: "p99",
            }),
          ],
        }),
      );
    }

    // ------------------------------------------------------------- database
    this.dashboard.addWidgets(
      new cloudwatch.GraphWidget({
        title: "RDS: CPU (%) and connections",
        width: 12,
        left: [props.database.metricCPUUtilization({ period: Duration.minutes(5) })],
        right: [props.database.metricDatabaseConnections({ period: Duration.minutes(5) })],
        leftYAxis: { min: 0, max: 100 },
      }),
      new cloudwatch.GraphWidget({
        title: "RDS: free storage and memory (bytes)",
        width: 12,
        left: [
          props.database.metricFreeStorageSpace({ period: Duration.minutes(5) }),
          props.database.metricFreeableMemory({ period: Duration.minutes(5) }),
        ],
      }),
    );

    // --------------------------------------------------------------- alarms
    //
    // Five. Each corresponds to something worth being interrupted for.

    // Nothing is serving. The single most important signal here, and the one that
    // fires if a deploy rolls out a container that cannot reach its database.
    for (const svc of props.services) {
      new cloudwatch.Alarm(this, `${svc.serviceName}-NoHealthyTargets`, {
        alarmName: `aadyon-${svc.serviceName}-no-healthy-targets`,
        alarmDescription: `No healthy targets behind ${svc.serviceName}. The service is down.`,
        metric: svc.targetGroup.metrics.healthyHostCount({ period: Duration.minutes(1) }),
        threshold: 1,
        comparisonOperator: cloudwatch.ComparisonOperator.LESS_THAN_THRESHOLD,
        evaluationPeriods: 3,
        // A target group with no registered targets reports no data rather than zero,
        // which is exactly the case worth alarming on. Left at the default it would sit
        // INSUFFICIENT_DATA through a total outage.
        treatMissingData: cloudwatch.TreatMissingData.BREACHING,
      }).addAlarmAction(notify);
    }

    new cloudwatch.Alarm(this, "Target5xx", {
      alarmName: "aadyon-target-5xx",
      alarmDescription: "Applications are returning server errors",
      metric: target5xx,
      threshold: 10,
      evaluationPeriods: 2,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    }).addAlarmAction(notify);

    // 20 GB allocated, so 2 GB is 10 percent. A full disk takes Postgres down hard and
    // recovering means an instance modification, which is not fast.
    new cloudwatch.Alarm(this, "RdsStorage", {
      alarmName: "aadyon-rds-low-storage",
      alarmDescription: "RDS free storage below 2 GB",
      metric: props.database.metricFreeStorageSpace({ period: Duration.minutes(5) }),
      threshold: 2 * 1024 * 1024 * 1024,
      comparisonOperator: cloudwatch.ComparisonOperator.LESS_THAN_THRESHOLD,
      evaluationPeriods: 2,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    }).addAlarmAction(notify);

    // t4g.micro is burstable. Sustained high CPU means the instance is either
    // undersized or burning CPU credits it will not get back, and when they run out
    // the database does not fail, it simply becomes extremely slow.
    new cloudwatch.Alarm(this, "RdsCpu", {
      alarmName: "aadyon-rds-cpu",
      alarmDescription: "RDS CPU above 85 percent for 15 minutes",
      metric: props.database.metricCPUUtilization({ period: Duration.minutes(5) }),
      threshold: 85,
      evaluationPeriods: 3,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    }).addAlarmAction(notify);

    // --------------------------------------------------------------- budget
    //
    // Not a CloudWatch alarm. Billing metrics only exist in us-east-1 and only after
    // being switched on, whereas Budgets works from the start and can alert on
    // *forecast* spend, which is what catches a mistake in week one rather than at the
    // end of the month when the money is already gone.
    if (props.alarmEmail) {
      const thresholds = [
        { type: "ACTUAL", threshold: 80, label: "80 percent of budget spent" },
        { type: "ACTUAL", threshold: 100, label: "budget exceeded" },
        { type: "FORECASTED", threshold: 100, label: "forecast to exceed budget" },
      ];
      new budgets.CfnBudget(this, "MonthlyBudget", {
        budget: {
          budgetName: "aadyon-monthly",
          budgetType: "COST",
          timeUnit: "MONTHLY",
          budgetLimit: { amount: props.monthlyBudgetUsd, unit: "USD" },
        },
        notificationsWithSubscribers: thresholds.map((t) => ({
          notification: {
            notificationType: t.type,
            comparisonOperator: "GREATER_THAN",
            threshold: t.threshold,
            thresholdType: "PERCENTAGE",
          },
          subscribers: [{ subscriptionType: "EMAIL", address: props.alarmEmail as string }],
        })),
      });
    }
  }

  /**
   * Saved Logs Insights queries.
   *
   * These are the ones worth having typed out in advance, because you reach for them
   * when something is broken and that is the worst time to be composing a query.
   */
  public static readonly savedQueries: Record<string, string> = {
    errors: [
      "fields @timestamp, @message",
      "| filter @message like /(?i)(error|exception|traceback|critical)/",
      "| sort @timestamp desc",
      "| limit 100",
    ].join("\n"),
    slowRequests: [
      "fields @timestamp, @message",
      "| parse @message /(?<ms>\\d+)ms/",
      "| filter ms > 1000",
      "| sort ms desc",
      "| limit 50",
    ].join("\n"),
    startupFailures: [
      "fields @timestamp, @message",
      "| filter @message like /(?i)(database unreachable|connection refused|could not connect|OperationalError)/",
      "| sort @timestamp desc",
      "| limit 50",
    ].join("\n"),
  };
}

/** The stack's region, for building console links in outputs. */
export function consoleRegion(scope: Construct): string {
  return Stack.of(scope).region;
}
