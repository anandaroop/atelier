import { randomUUID } from "node:crypto";
import { type CloudFrontClient, CreateInvalidationCommand } from "@aws-sdk/client-cloudfront";

export async function invalidateSlug(
  client: CloudFrontClient,
  distributionId: string,
  slug: string,
): Promise<void> {
  await client.send(
    new CreateInvalidationCommand({
      DistributionId: distributionId,
      InvalidationBatch: {
        CallerReference: randomUUID(),
        Paths: { Quantity: 1, Items: [`/${slug}/*`] },
      },
    }),
  );
}
