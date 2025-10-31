import { MessageId, type Queue, ValidQueueName } from "@workflow/world";
import z from "zod";

import { SQSClient, SendMessageCommand } from "@aws-sdk/client-sqs";

export function createQueue({ queueUrl }: { queueUrl: string }): Queue {
  /**
   * holds inflight messages by idempotency key to ensure
   * that we don't queue the same message multiple times
   */

  const queue: Queue["queue"] = async (queueName, message) => {
    const client = new SQSClient({});

    let pathname: string;
    if (queueName.startsWith("__wkf_step_")) {
      pathname = "step";
    } else if (queueName.startsWith("__wkf_workflow_")) {
      pathname = "flow";
    } else {
      throw new Error("Unknown queue name prefix");
    }

    const command = new SendMessageCommand({
      QueueUrl: queueUrl,
      MessageBody: JSON.stringify({
        message,
        webhookUri: `/.well-known/workflow/v1/${pathname}`,
      }),
      MessageGroupId: queueName,
    });

    const response = await client.send(command);

    if (!response.MessageId) {
      throw new Error("Failed to queue message");
    }

    const messageId = MessageId.parse(response.MessageId);

    return { messageId };
  };

  const HeaderParser = z.object({
    "x-vqs-queue-name": ValidQueueName,
    "x-vqs-message-id": MessageId,
    "x-vqs-message-attempt": z.coerce.number(),
  });

  const createQueueHandler: Queue["createQueueHandler"] = (prefix, handler) => {
    return async (req) => {
      // TODO: implement auth here?
      const headers = HeaderParser.safeParse(Object.fromEntries(req.headers));

      if (!headers.success || !req.body) {
        return Response.json(
          { error: "Missing required headers" },
          { status: 400 }
        );
      }

      const queueName = headers.data["x-vqs-queue-name"];
      const messageId = headers.data["x-vqs-message-id"];
      const attempt = headers.data["x-vqs-message-attempt"];

      if (!queueName.startsWith(prefix)) {
        return Response.json({ error: "Unhandled queue" }, { status: 400 });
      }

      const body = await req.json();
      try {
        const response = await handler(body, { attempt, queueName, messageId });
        const retryIn =
          typeof response === "undefined" ? null : response.timeoutSeconds;

        if (retryIn) {
          return Response.json({ retryIn }, { status: 503 });
        }

        return Response.json({ ok: true });
      } catch (error) {
        return Response.json(String(error), { status: 500 });
      }
    };
  };

  const getDeploymentId: Queue["getDeploymentId"] = async () => {
    return "dpl_embedded";
  };

  return { queue, createQueueHandler, getDeploymentId };
}
