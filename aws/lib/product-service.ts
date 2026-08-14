import { Duration, RemovalPolicy } from "aws-cdk-lib";
import * as ec2 from "aws-cdk-lib/aws-ec2";
import * as ecs from "aws-cdk-lib/aws-ecs";
import * as elbv2 from "aws-cdk-lib/aws-elasticloadbalancingv2";
import * as iam from "aws-cdk-lib/aws-iam";
import * as logs from "aws-cdk-lib/aws-logs";
import * as cloudmap from "aws-cdk-lib/aws-servicediscovery";
import { Construct } from "constructs";

export interface ProductServiceProps {
  readonly cluster: ecs.ICluster;
  readonly vpc: ec2.IVpc;
  readonly loadBalancer: elbv2.IApplicationLoadBalancer;
  readonly loadBalancerSecurityGroup: ec2.ISecurityGroup;

  /** Also the Cloud Map DNS name, so siblings reach it at http://<name>.<namespace>. */
  readonly serviceName: string;
  readonly image: ecs.ContainerImage;
  readonly containerPort: number;

  /**
   * Port on the shared load balancer. One balancer with several listeners costs the
   * same as one with a single listener, and avoids needing a domain and certificate
   * per product just to tell them apart by host.
   */
  readonly listenerPort: number;
  readonly healthCheckPath: string;

  readonly namespace: cloudmap.IPrivateDnsNamespace;
  readonly environment?: Record<string, string>;
  readonly secrets?: Record<string, ecs.Secret>;
  readonly cpu?: number;
  readonly memoryLimitMiB?: number;
  readonly desiredCount?: number;

  /** Grace period before the first health check counts. Bigger images need longer. */
  readonly healthCheckGracePeriod?: Duration;
}

/**
 * One containerised product: a Fargate service, its log group, its place on the shared
 * load balancer, and a private DNS name its siblings can call.
 *
 * Tasks run in **public** subnets with a public IP. That reads wrong at first glance,
 * so it is worth stating plainly: the alternative is private subnets, and private
 * subnets need a NAT gateway to reach ECR and Secrets Manager, at about 32 USD per
 * month per gateway before any data processing. That single line item would have cost
 * more than everything else in this stack combined.
 *
 * What actually protects the task is its security group, which accepts traffic only
 * from the load balancer. A public IP with no ingress path is not an open door. The
 * database is a separate matter and stays in isolated subnets with no route to the
 * internet at all.
 */
export class ProductService extends Construct {
  public readonly service: ecs.FargateService;
  public readonly securityGroup: ec2.SecurityGroup;

  /**
   * The identity the container runs as. Exposed so callers can grant it access to
   * things directly, which is the point: boto3 and the AWS SDKs pick this up through
   * the default credential chain, so a task reaches S3 with no access key anywhere in
   * the configuration, the image, or this repository.
   */
  public readonly taskRole: iam.IRole;

  /** Exposed so the dashboard can graph health and latency per product. */
  public readonly targetGroup: elbv2.ApplicationTargetGroup;

  /** Kept for widget titles and alarm names. */
  public readonly serviceName: string;

  constructor(scope: Construct, id: string, props: ProductServiceProps) {
    super(scope, id);
    this.serviceName = props.serviceName;

    const taskDefinition = new ecs.FargateTaskDefinition(this, "TaskDef", {
      cpu: props.cpu ?? 256,
      memoryLimitMiB: props.memoryLimitMiB ?? 512,
      runtimePlatform: {
        cpuArchitecture: ecs.CpuArchitecture.X86_64,
        operatingSystemFamily: ecs.OperatingSystemFamily.LINUX,
      },
    });

    this.taskRole = taskDefinition.taskRole;

    taskDefinition.addContainer("app", {
      image: props.image,
      environment: props.environment,
      // Injected by the agent at task start, resolved from Secrets Manager by ARN.
      // The values never appear in the task definition, in CloudFormation, or in any
      // console view of either.
      secrets: props.secrets,
      portMappings: [{ containerPort: props.containerPort }],
      logging: ecs.LogDrivers.awsLogs({
        streamPrefix: props.serviceName,
        logGroup: new logs.LogGroup(this, "Logs", {
          logGroupName: `/aadyon/${props.serviceName}`,
          // Logs are the quiet line item that grows forever. Two weeks is long enough
          // to debug a bad deploy and short enough to stay near zero.
          retention: logs.RetentionDays.TWO_WEEKS,
          // CDK defaults log groups to RETAIN, which sounds prudent and is actively
          // harmful for a named group: a rolled-back stack leaves the group behind, and
          // the next deploy fails with "already exists" before it creates anything. The
          // retention above already caps what is kept, so retaining the container past
          // the stack it belongs to preserves nothing except an obstacle.
          removalPolicy: RemovalPolicy.DESTROY,
        }),
      }),
    });

    this.securityGroup = new ec2.SecurityGroup(this, "ServiceSg", {
      vpc: props.vpc,
      description: `Task security group for ${props.serviceName}`,
      allowAllOutbound: true,
    });
    this.securityGroup.addIngressRule(
      props.loadBalancerSecurityGroup,
      ec2.Port.tcp(props.containerPort),
      "Application load balancer to task",
    );

    this.service = new ecs.FargateService(this, "Service", {
      cluster: props.cluster,
      taskDefinition,
      desiredCount: props.desiredCount ?? 1,
      assignPublicIp: true,
      vpcSubnets: { subnetType: ec2.SubnetType.PUBLIC },
      securityGroups: [this.securityGroup],
      healthCheckGracePeriod: props.healthCheckGracePeriod ?? Duration.seconds(120),
      cloudMapOptions: {
        name: props.serviceName,
        cloudMapNamespace: props.namespace,
        dnsRecordType: cloudmap.DnsRecordType.A,
        dnsTtl: Duration.seconds(15),
      },
      circuitBreaker: { rollback: true },
      minHealthyPercent: 100,
    });

    const listener = props.loadBalancer.addListener(`Listener${props.listenerPort}`, {
      port: props.listenerPort,
      protocol: elbv2.ApplicationProtocol.HTTP,
      open: true,
    });

    this.targetGroup = listener.addTargets("Target", {
      port: props.containerPort,
      protocol: elbv2.ApplicationProtocol.HTTP,
      targets: [this.service],
      healthCheck: {
        path: props.healthCheckPath,
        interval: Duration.seconds(30),
        timeout: Duration.seconds(10),
        healthyThresholdCount: 2,
        unhealthyThresholdCount: 3,
      },
      // Well under the default 300s. These are stateless request/response services;
      // holding a draining task for five minutes only slows deploys down.
      deregistrationDelay: Duration.seconds(20),
    });
  }
}
