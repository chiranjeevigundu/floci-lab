import * as path from "node:path";
import { CfnOutput, Duration, RemovalPolicy, Stack, type StackProps } from "aws-cdk-lib";
import * as ec2 from "aws-cdk-lib/aws-ec2";
import * as ecs from "aws-cdk-lib/aws-ecs";
import * as elbv2 from "aws-cdk-lib/aws-elasticloadbalancingv2";
import * as rds from "aws-cdk-lib/aws-rds";
import * as secretsmanager from "aws-cdk-lib/aws-secretsmanager";
import * as cloudmap from "aws-cdk-lib/aws-servicediscovery";
import type { Construct } from "constructs";
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
        version: rds.PostgresEngineVersion.VER_16_6,
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
      cpu: 512,
      memoryLimitMiB: 1024,
      environment: {
        DB_HOST: database.dbInstanceEndpointAddress,
        DB_USER: "aadyon",
        POSTGRES_DB: "aadyon",
        DEV_MODE: "false",
        // Over the private namespace rather than back out through the load balancer.
        // Same VPC, no public hop, and it keeps working if the RAG listener is closed.
        RAG_SERVICE_URL: `http://hybrid-rag.${namespace.namespaceName}:8080`,
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
    new CfnOutput(this, "DatabaseSecretArn", {
      value: database.secret!.secretArn,
      description: "Secrets Manager ARN of the generated master credentials",
    });
  }
}
