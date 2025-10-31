import type { World } from "@workflow/world";
import { config } from "./config";
import { createQueue } from "./queue";
import { createStorage } from "./storage";
import { createStreamer } from "./streamer";

/**
 * Creates an embedded world instance that combines queue, storage, and streamer functionalities.
 *
 * @param dataDir - The directory to use for storage. If not provided, the default data dir will be used.
 * @param port - The port to use for the queue. If not provided, the default port will be used.
 */
export function createWorld(): World {
  const dir = config.value.dataDir;

  const queueUrl = process.env.WORKFLOW_SQS_QUEUE_URL;
  console.log("queueUrl", queueUrl);
  if (!queueUrl) {
    throw new Error("WORKFLOW_SQS_QUEUE_URL is not set");
  }

  const tableName = process.env.WORKFLOW_TABLE_NAME;
  if (!tableName) {
    throw new Error("WORKFLOW_TABLE_NAME is not set");
  }

  return {
    ...createQueue({ queueUrl }),
    ...createStorage({ tableName }),
    ...createStreamer(dir),
  };
}

export { createLambdaHandler } from "./lambda";
