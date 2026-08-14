# Aadyon on AWS

CDK for `hybrid-rag` and `aadyon-assist` on ECS Fargate, sharing one VPC, one load
balancer and one RDS instance.

The other half of this repository runs the same products against a local emulator. This
half runs them for real. `aadyon-server` and `synapse` are deliberately not here; see
[What is not here](#what-is-not-here).

```bash
npm ci
npx cdk synth          # works with no AWS session at all
npx cdk bootstrap      # once per account and region
npx cdk deploy
```

## Status: synthesised, not deployed

Nothing in this directory has ever run against AWS. `cdk synth` passes and the template
has been inspected, which catches structural errors but proves nothing about IAM,
quotas, or whether the containers actually come up.

Before it can be deployed, three things need doing that are **not** automated below.
They are listed under [Before the first deploy](#before-the-first-deploy).

## What it builds

| | |
|---|---|
| VPC | 2 AZs, public + isolated subnets, **no NAT gateway** |
| ECS | one Fargate cluster, two services, Cloud Map at `aadyon.local` |
| Edge | one internet-facing ALB. `:80` to assist, `:8080` to hybrid-rag |
| Data | one RDS Postgres 16 `t4g.micro`, isolated subnets, encrypted, 7-day backups |
| Secrets | RDS master (generated), assist JWT (generated), OpenRouter key (placeholder) |

### Why the tasks sit in public subnets

This looks wrong and is worth stating plainly. The alternative is private subnets, and
private subnets need a NAT gateway to reach ECR and Secrets Manager, at roughly **32 USD
per month each** before data processing. That one line item would cost more than
everything else here combined.

What protects a task is its security group, which accepts traffic only from the load
balancer. A public IP with no ingress path is not an open door. The database is a
different matter and sits in isolated subnets with no route to the internet at all.

### Rough monthly cost

| Item | |
|---|---|
| ALB | ~16 USD |
| RDS `t4g.micro` + 20 GB gp3 | ~13-15 USD |
| Fargate, 2 × 0.5 vCPU / 1 GB, always on | ~18 USD |
| NAT gateways | **0** |
| **Total** | **~47-50 USD/month** |

Set a billing alarm before deploying. Scaling `desiredCount` to 0 when not demonstrating
takes the Fargate portion to zero and leaves the ALB and RDS running.

## Before the first deploy

**1. Not as root.** The account has been used as `:root`. Create an IAM identity with
least privilege and use that. Root credentials cannot be scoped, cannot be rotated
without changing the account password, and cannot be revoked if leaked.

**2. Create the second database.** RDS creates only the database named in
`databaseName`, which is `aadyon`. hybrid-rag needs its own. From a host inside the VPC,
or through a bastion or session-manager tunnel:

```sql
CREATE DATABASE rag;
```

**3. Run the migrations.** Neither service applies its own schema at startup, by design:
a container that migrates on boot will happily run two migrations concurrently when the
scheduler starts two tasks. `hybrid-rag/migrations/*.sql` and `aadyon-assist`'s schema
both need applying once, and `hybrid-rag` additionally needs `CREATE EXTENSION vector`,
which its `001_schema.sql` already does. pgvector ships with RDS Postgres 15.2 and later,
so no custom parameter group is needed.

A migration task in the stack is the right answer and is not written yet.

## HTTP, not HTTPS

The load balancer serves plain HTTP, because ACM will not issue a certificate without a
domain you control and none is configured.

**This matters more for assist than it looks.** It authenticates with a bearer token and
carries personal finance data; over plain HTTP both are readable by anything on the path.
Treat the current configuration as a demonstration, and do not put real records in it
until a domain and certificate exist.

## Secrets

Nothing here ever reads a secret value. CDK references secrets by ARN, the ECS agent
resolves them at task start, and the value goes directly into the container environment.
It appears in no template, no console view, and no log.

The OpenRouter secret is created with a generated **placeholder**. Set the real key
yourself, out of band; the stack does not need redeploying after you do, but the service
does need restarting to pick it up.

Assist reads `POSTGRES_PASSWORD`, not `DB_PASSWORD`. Its config prefers a file at
`/run/secrets/db_password`, which does not exist on Fargate, so it falls through to the
environment. That name being wrong fails at the first query rather than at startup, which
is a slow way to find out.

## What is not here

**`aadyon-server` (Worth).** Hosting it is a product decision, not an infrastructure one:
running the sync server for other people's ciphertext means uptime and backup obligations
that shipping software carrying none does not.

**`synapse`.** Its data is a NAS at `/mnt/nas_data` and it deploys to a machine beside it.
The compute is next to the data on purpose. Moving it means either replicating a personal
document archive into S3 or letting AWS reach into a home network.

Both remain on the local path in the parent directory.

## Layout

```
bin/aadyon.ts           app entry; resolves the sibling checkouts
lib/platform-stack.ts   VPC, cluster, ALB, RDS, secrets, both services
lib/product-service.ts  one containerised product: task, service, listener, DNS
```

Everything is one stack on purpose. Splitting shared infrastructure from the services
that consume it turns a VPC reference into a CloudFormation export, and an export cannot
change while anything imports it. The "clean" split is what stops you replacing the load
balancer later without tearing down both services first.

Images are built from the sibling checkouts by `ContainerImage.fromAsset`, the same
convention the k8s deployer uses. Set `AADYON_REPO_ROOT` if they live elsewhere.
