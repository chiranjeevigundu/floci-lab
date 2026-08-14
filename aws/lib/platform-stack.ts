import * as path from "node:path";
import { CfnOutput, Duration, RemovalPolicy, Stack, type StackProps } from "aws-cdk-lib";
import * as ec2 from "aws-cdk-lib/aws-ec2";
import * as ecs from "aws-cdk-lib/aws-ecs";
import * as elbv2 from "aws-cdk-lib/aws-elasticloadbalancingv2";
import * as rds from "aws-cdk-lib/aws-rds";
import * as s3 from "aws-cdk-lib/aws-s3";
import * as secretsmanager from "aws-cdk-lib/aws-secretsmanager";
import * as cloudmap from "aws-cdk-lib/aws-servicediscovery";
import type { Construct } from "constructs";
import { Observability } from "./observability";
import { ProductService } from "./product-service";

export interface PlatformStackProps extends StackProps {
  /**
   * Directory holding the product checkouts, siblings of floci-lab. The same
   * convention the k8s deployer uses, for the same reason: the products build with
   * their own subdirectory as the Docker context, so vendoring or submoduling them
   * here would not make them visible to the build anyway.
   */
  readonly repoRoot: string;
}

/**
 * Everything, in one stack.
 *
 * Splitting shared infrastructure from the services that use it is the usual advice,
 * and it is wrong at this size. A cross-stack reference to a VPC or a load balancer
 * becomes a CloudFormation export, and an export cannot change while anything imports
 * it, so the "clean" split is what stops you replacing the load balancer later without
 * tearing down both services first. Two products do not need that.
 */
export class PlatformStack extends Stack {
  constructor(scope: Construct, id: string, props: PlatformStackProps) {
    super(scope, id, props);

    // ---------------------------------------------------------------- network
    //
    // natGateways: 0 is the single most consequential line in this file. A NAT gateway
    // is roughly 32 USD per month each before data processing, and the default VPC
    // layout creates one per availability zone. Left at the default this stack would
    // cost more in address translation than in compute and database together.
    const vpc = new ec2.Vpc(this, "Vpc", {
      maxAzs: 2,
      natGateways: 0,
      subnetConfiguration: [
        { name: "public", subnetType: ec2.SubnetType.PUBLIC, cidrMask: 24 },
        // Isolated, not private-with-egress: the database has no reason to originate
        // a connection to the internet, and giving it no route is cheaper and safer
        // than giving it one and writing a rule against it.
        { name: "data", subnetType: ec2.SubnetType.PRIVATE_ISOLATED, cidrMask: 24 },
      ],
    });

    // S3 traffic (ECR stores layers in S3) leaves through a gateway endpoint rather
    // than the internet. Gateway endpoints are free, unlike interface endpoints.
    vpc.addGatewayEndpoint("S3Endpoint", { service: ec2.GatewayVpcEndpointAwsService.S3 });

    const cluster = new ecs.Cluster(this, "Cluster", {
      vpc,
      clusterName: "aadyon",
      // Container Insights bills per metric and per log ingested. Off by default; the
      // task logs and the load balancer's own metrics cover ordinary debugging.
      containerInsightsV2: ecs.ContainerInsights.DISABLED,
    });

    const namespace = new cloudmap.PrivateDnsNamespace(this, "Namespace", {
      name: "aadyon.local",
      vpc,
      description: "Private DNS for service to service calls inside the VPC",
    });

    // ------------------------------------------------------------------ edge
    const albSecurityGroup = new ec2.SecurityGroup(this, "AlbSg", {
      vpc,
      description: "Public ingress to the application load balancer",
      allowAllOutbound: true,
    });

    const alb = new elbv2.ApplicationLoadBalancer(this, "Alb", {
      vpc,
      internetFacing: true,
      securityGroup: albSecurityGroup,
      vpcSubnets: { subnetType: ec2.SubnetType.PUBLIC },
    });

    // -------------------------------------------------------------- database
    const dbSecurityGroup = new ec2.SecurityGroup(this, "DbSg", {
      vpc,
      description: "Postgres, reachable only from the Fargate tasks",
      allowAllOutbound: false,
    });

    const database = new rds.DatabaseInstance(this, "Database", {
      engine: rds.DatabaseInstanceEngine.postgres({
        // Written as a literal rather than PostgresEngineVersion.VER_16_x on purpose.
        // The enum is a compile-time list baked into whichever aws-cdk-lib is installed,
        // and it does not track what RDS actually offers: VER_16_6 exists in the enum,
        // type checks, synthesises, and then fails at deploy with "Cannot find version
        // 16.6 for postgres" because RDS never shipped it in this region. A literal is
        // no less safe and is honest about the fact that only RDS knows the answer.
        //   aws rds describe-orderable-db-instance-options \
        //     --engine postgres --db-instance-class db.t4g.micro \
        //     --query 'OrderableDBInstanceOptions[].EngineVersion'
        version: rds.PostgresEngineVersion.of("16.14", "16"),
      }),
      // Graviton burstable. pgvector ships with RDS Postgres 15.2 and later, so
      // hybrid-rag's CREATE EXTENSION vector works without a custom parameter group.
      instanceType: ec2.InstanceType.of(ec2.InstanceClass.BURSTABLE4_GRAVITON, ec2.InstanceSize.MICRO),
      vpc,
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_ISOLATED },
      securityGroups: [dbSecurityGroup],
      multiAz: false,
      allocatedStorage: 20,
      storageType: rds.StorageType.GP3,
      // RDS generates the password into Secrets Manager and nothing else ever sees it.
      // It is read at task start by the ECS agent, by ARN.
      credentials: rds.Credentials.fromGeneratedSecret("aadyon", {
        secretName: "aadyon/rds/master",
      }),
      databaseName: "aadyon",
      backupRetention: Duration.days(7),
      deleteAutomatedBackups: false,
      // Destroying the stack takes a final snapshot rather than deleting the data.
      // This database holds personal finance records; losing them to a cdk destroy
      // typed in the wrong directory is not an acceptable failure mode.
      removalPolicy: RemovalPolicy.SNAPSHOT,
      deletionProtection: false,
      storageEncrypted: true,
      publiclyAccessible: false,
    });

    // ------------------------------------------------------------ app secrets
    //
    // Created empty-ish and filled in out of band. Nothing in this repository ever
    // reads a secret value: CDK references them by ARN, the ECS agent resolves them at
    // task start, and the value goes straight into the container's environment.
    const jwtSecret = new secretsmanager.Secret(this, "JwtSecret", {
      secretName: "aadyon/assist/jwt",
      description: "Signing key for aadyon-assist session tokens",
      generateSecretString: { passwordLength: 48, excludePunctuation: true },
    });

    const openRouterKey = new secretsmanager.Secret(this, "OpenRouterKey", {
      secretName: "aadyon/assist/openrouter",
      description: "OpenRouter API key. Set this yourself; the generated value is a placeholder",
      generateSecretString: { passwordLength: 16, excludePunctuation: true },
    });

    // How many tasks each service runs. Zero is not a curiosity: on a first deploy the
    // databases do not exist and no migration has run, and /health does a real query,
    // so a task would never turn healthy and the circuit breaker would roll back the
    // whole stack after RDS had spent fifteen minutes creating itself. Bring the
    // infrastructure up empty, bootstrap the schemas, then scale up.
    //   cdk deploy -c desiredCount=0
    const desiredCount = Number(this.node.tryGetContext("desiredCount") ?? 1);

    // ------------------------------------------------------------- storage
    //
    // Adopted, not created. This bucket predates the stack and already holds uploads,
    // so CDK references it by name and grants access to it. Declaring a new bucket here
    // would either fail on the name already existing or, worse, succeed with a
    // different name and quietly strand everything already stored.
    const uploads = s3.Bucket.fromBucketName(
      this,
      "Uploads",
      `aadyon-uploads-${this.account}`,
    );

    // ------------------------------------------------------------- services
    const ragService = new ProductService(this, "HybridRag", {
      cluster,
      vpc,
      loadBalancer: alb,
      loadBalancerSecurityGroup: albSecurityGroup,
      namespace,
      serviceName: "hybrid-rag",
      image: ecs.ContainerImage.fromAsset(path.join(props.repoRoot, "hybrid-rag")),
      containerPort: 8080,
      listenerPort: 8080,
      healthCheckPath: "/health",
      desiredCount,
      // The image carries the embedding model and is about 1.4 GB, and the service
      // builds an ONNX session before it answers /health. A short grace period would
      // kill the task while it is still starting, forever.
      healthCheckGracePeriod: Duration.seconds(300),
      cpu: 512,
      memoryLimitMiB: 1024,
      environment: {
        RAG_CACHE_DIR: "/opt/models",
        // ragkit assembles the DSN from these when DATABASE_URL is unset, quoting the
        // password as it goes. Building the URL here instead would mean interpolating a
        // generated credential into a string in this file.
        RAG_DB_HOST: database.dbInstanceEndpointAddress,
        RAG_DB_PORT: database.dbInstanceEndpointPort,
        RAG_DB_USER: "aadyon",
        // Its own database on the shared instance. RDS creates only the one named in
        // databaseName, so this has to be created once by hand; see the README.
        RAG_DB_NAME: "rag",
      },
      secrets: {
        RAG_DB_PASSWORD: ecs.Secret.fromSecretsManager(database.secret!, "password"),
      },
    });

    const assistService = new ProductService(this, "Assist", {
      cluster,
      vpc,
      loadBalancer: alb,
      loadBalancerSecurityGroup: albSecurityGroup,
      namespace,
      serviceName: "aadyon-assist",
      image: ecs.ContainerImage.fromAsset(path.join(props.repoRoot, "aadyon-assist", "code"), {
        file: path.join("api", "Dockerfile"),
      }),
      containerPort: 8000,
      listenerPort: 80,
      healthCheckPath: "/api/health",
      desiredCount,
      cpu: 512,
      memoryLimitMiB: 1024,
      environment: {
        DB_HOST: database.dbInstanceEndpointAddress,
        // aadyon_app, NOT aadyon. The two roles are not interchangeable: aadyon owns
        // the schema and is DDL-privileged, which means Postgres exempts it from row
        // level security entirely. aadyon_app is the restricted role the FORCE ROW
        // LEVEL SECURITY policies actually bind to.
        //
        // Running the API as the owner does not fail, warn, or degrade. Every query
        // simply returns every tenant's rows, and with a single test account that looks
        // exactly like working software.
        DB_USER: "aadyon_app",
        POSTGRES_DB: "aadyon",
        DEV_MODE: "false",
        // Over the private namespace rather than back out through the load balancer.
        // Same VPC, no public hop, and it keeps working if the RAG listener is closed.
        RAG_SERVICE_URL: `http://hybrid-rag.${namespace.namespaceName}:8080`,
        // Uploads must not go to the container filesystem. Fargate discards it on every
        // task replacement, so a document uploaded on Tuesday is gone after Wednesday's
        // deploy, and nothing reports an error when it happens.
        STORAGE_BACKEND: "s3",
        S3_BUCKET_NAME: uploads.bucketName,
        S3_REGION: this.region,
        // The task role is scoped to this one bucket and cannot call CreateBucket. The
        // bucket already exists, so the startup bootstrap has nothing to do and would
        // only fail with an access denied that looks like a misconfiguration.
        S3_AUTO_CREATE_BUCKET: "false",
        // No S3_ACCESS_KEY or S3_SECRET_KEY on purpose. llmkit passes static
        // credentials only when both are set, so leaving them unset falls through to
        // boto3's default chain, which on Fargate is the task role.
      },
      secrets: {
        // Assist reads POSTGRES_PASSWORD, not DB_PASSWORD. Its config prefers a file
        // at /run/secrets/db_password, which does not exist on Fargate, so it falls
        // through to the environment. Getting this name wrong fails at first query,
        // not at startup.
        POSTGRES_PASSWORD: ecs.Secret.fromSecretsManager(database.secret!, "password"),
        JWT_SECRET: ecs.Secret.fromSecretsManager(jwtSecret),
        OPENROUTER_API_KEY: ecs.Secret.fromSecretsManager(openRouterKey),
      },
    });

    // Read and write on the uploads bucket, and nothing else anywhere. This replaces
    // the aadyon-s3 IAM user's static access key, which never needs to exist for a
    // deployment that runs inside AWS.
    uploads.grantReadWrite(assistService.taskRole);

    dbSecurityGroup.addIngressRule(
      ragService.securityGroup,
      ec2.Port.tcp(5432),
      "hybrid-rag to Postgres",
    );
    dbSecurityGroup.addIngressRule(
      assistService.securityGroup,
      ec2.Port.tcp(5432),
      "aadyon-assist to Postgres",
    );

    // ------------------------------------------------------- observability
    //
    // alarmEmail is context-driven because a subscription has to be confirmed from the
    // inbox; wiring an address nobody confirms produces alarms that fire into nothing,
    // which is worse than having none because it looks covered.
    //   cdk deploy -c alarmEmail=you@example.com
    const alarmEmail = this.node.tryGetContext("alarmEmail") as string | undefined;
    const observability = new Observability(this, "Observability", {
      loadBalancer: alb,
      database,
      services: [ragService, assistService],
      alarmEmail,
      monthlyBudgetUsd: Number(this.node.tryGetContext("monthlyBudgetUsd") ?? 75),
    });

    // ------------------------------------------------------------- outputs
    new CfnOutput(this, "AssistUrl", {
      value: `http://${alb.loadBalancerDnsName}`,
      description: "aadyon-assist. Plain HTTP until a domain and certificate exist",
    });
    new CfnOutput(this, "RagUrl", {
      value: `http://${alb.loadBalancerDnsName}:8080`,
      description: "hybrid-rag retrieval service",
    });
    new CfnOutput(this, "DatabaseEndpoint", {
      value: database.dbInstanceEndpointAddress,
      description: "Postgres endpoint, reachable only from inside the VPC",
    });
    new CfnOutput(this, "DashboardUrl", {
      value: `https://${this.region}.console.aws.amazon.com/cloudwatch/home?region=${this.region}#dashboards/dashboard/${observability.dashboard.dashboardName}`,
      description: "CloudWatch dashboard",
    });
    new CfnOutput(this, "AlarmTopicArn", {
      value: observability.alarmTopic.topicArn,
      description: "SNS topic alarms publish to",
    });
    new CfnOutput(this, "DatabaseSecretArn", {
      value: database.secret!.secretArn,
      description: "Secrets Manager ARN of the generated master credentials",
    });
  }
}
