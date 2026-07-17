import { CloudFrontClient, CreateInvalidationCommand } from "@aws-sdk/client-cloudfront";
import { mockClient } from "aws-sdk-client-mock";
import { invalidateSlug } from "./cloudfront";

const cloudfrontMock = mockClient(CloudFrontClient);
const client = new CloudFrontClient({ region: "us-east-1" });
const distributionId = "E123EXAMPLE";

beforeEach(() => {
  cloudfrontMock.reset();
});

describe("invalidateSlug", () => {
  it("issues a CreateInvalidation for the slug's path prefix", async () => {
    cloudfrontMock.on(CreateInvalidationCommand).resolves({
      Invalidation: {
        Id: "INVALIDATION123",
        Status: "InProgress",
        CreateTime: new Date("2026-07-17T00:00:00.000Z"),
        InvalidationBatch: {
          CallerReference: "test",
          Paths: { Quantity: 1, Items: ["/marketing-dashboard/*"] },
        },
      },
    });

    await invalidateSlug(client, distributionId, "marketing-dashboard");

    const calls = cloudfrontMock.commandCalls(CreateInvalidationCommand);
    expect(calls).toHaveLength(1);
    const input = calls[0]?.args[0].input;
    expect(input?.DistributionId).toBe(distributionId);
    expect(input?.InvalidationBatch?.Paths?.Items).toEqual(["/marketing-dashboard/*"]);
    expect(input?.InvalidationBatch?.Paths?.Quantity).toBe(1);
    expect(input?.InvalidationBatch?.CallerReference).toBeTruthy();
  });

  it("surfaces errors from the CloudFront API rather than swallowing them", async () => {
    cloudfrontMock
      .on(CreateInvalidationCommand)
      .rejects(Object.assign(new Error("Access Denied"), { name: "AccessDenied" }));

    await expect(invalidateSlug(client, distributionId, "marketing-dashboard")).rejects.toThrow(
      "Access Denied",
    );
  });
});
