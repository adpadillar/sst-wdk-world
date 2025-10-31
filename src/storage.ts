import { Event, Hook, Step, WorkflowRun, type Storage } from "@workflow/world";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  DeleteCommand,
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  QueryCommand,
  UpdateCommand,
} from "@aws-sdk/lib-dynamodb";

import { monotonicFactory } from "ulid";
import { WorkflowAPIError } from "@workflow/errors";
import { createEmbeddedWorld } from "@workflow/world-local";

const client = new DynamoDBClient({});
const docClient = DynamoDBDocumentClient.from(client);

export function createStorage({ tableName }: { tableName: string }): Storage {
  createEmbeddedWorld({});

  return {
    events: loggerProxy(createEventsStorage(docClient, tableName), "events"),
    hooks: loggerProxy(createHooksStorage(docClient, tableName), "hooks"),
    runs: loggerProxy(createRunsStorage(docClient, tableName), "runs"),
    steps: loggerProxy(createStepsStorage(docClient, tableName), "steps"),
  };
}

// imports (adjust paths)

const ULID_PREFIX_RUN = "wrun_";
const ULID_PREFIX_EVT = "wevt_";
const ULID_PREFIX_STEP = "wstep_";

function nowMs() {
  return Date.now();
}

/**
 * Helper for table keys
 */
function runPK(runId: string) {
  return `RUN#${runId}`;
}
function runMetaSK() {
  return `RUN#METADATA`;
}
function stepSK(stepId: string) {
  return `STEP#${stepId}`;
}
function eventSK(eventId: string) {
  return `EVENT#${eventId}`;
}
function hookSK(hookId: string) {
  return `HOOK#${hookId}`;
}

export function createRunsStorage(
  dyn: DynamoDBDocumentClient,
  TABLE_NAME: string
): Storage["runs"] {
  const ulid = monotonicFactory();

  return {
    async get(id) {
      const Key = { PK: runPK(id), SK: runMetaSK() };
      const { Item } = await dyn.send(
        new GetCommand({ TableName: TABLE_NAME, Key })
      );
      if (!Item)
        throw new WorkflowAPIError(`Run not found: ${id}`, { status: 404 });
      return compact(Item) as WorkflowRun;
    },

    async cancel(id) {
      // set status=cancelled, set completedAt
      const Key = { PK: runPK(id), SK: runMetaSK() };
      // conditional update and return updated attributes
      const { Attributes } = await dyn.send(
        new UpdateCommand({
          TableName: TABLE_NAME,
          Key,
          UpdateExpression: "SET #s = :s, completedAt = :c, updatedAt = :u",
          ExpressionAttributeNames: { "#s": "status" },
          ExpressionAttributeValues: {
            ":s": "cancelled",
            ":c": nowMs(),
            ":u": nowMs(),
          },
          ReturnValues: "ALL_NEW",
        })
      );
      if (!Attributes)
        throw new WorkflowAPIError(`Run not found: ${id}`, { status: 404 });
      return compact(Attributes) as WorkflowRun;
    },

    async pause(id) {
      const Key = { PK: runPK(id), SK: runMetaSK() };

      const { Attributes } = await dyn.send(
        new UpdateCommand({
          TableName: TABLE_NAME,
          Key,
          UpdateExpression: "SET #s = :s, updatedAt = :u",
          ExpressionAttributeNames: { "#s": "status" },
          ExpressionAttributeValues: { ":s": "paused", ":u": nowMs() },
          ReturnValues: "ALL_NEW",
        })
      );
      if (!Attributes)
        throw new WorkflowAPIError(`Run not found: ${id}`, { status: 404 });
      return compact(Attributes) as WorkflowRun;
    },

    async resume(id) {
      // Only resume if currently paused
      const Key = { PK: runPK(id), SK: runMetaSK() };
      try {
        const { Attributes } = await dyn.send(
          new UpdateCommand({
            TableName: TABLE_NAME,
            Key,
            UpdateExpression: "SET #s = :new, updatedAt = :u",
            ConditionExpression: "#s = :old",
            ExpressionAttributeNames: { "#s": "status" },
            ExpressionAttributeValues: {
              ":new": "running",
              ":old": "paused",
              ":u": nowMs(),
            },
            ReturnValues: "ALL_NEW",
          })
        );
        return compact(Attributes as WorkflowRun);
      } catch (err: any) {
        // If conditional check failed or item doesn't exist
        throw new WorkflowAPIError(`Paused run not found: ${id}`, {
          status: 404,
        });
      }
    },

    async list(params) {
      const limit = params?.pagination?.limit ?? 20;
      const cursor = params?.pagination?.cursor; // ULID runId or createdAt-based cursor
      const workflowName = params?.workflowName;
      const status = params?.status;

      // Prefer querying workflowNameIndex or statusIndex if provided.
      // If workflowName provided:
      if (workflowName) {
        // Query GSI workflowNameIndex (hashKey=workflowName, rangeKey=createdAt)
        const q = {
          TableName: TABLE_NAME,
          IndexName: "workflowNameIndex",
          KeyConditionExpression:
            "workflowName = :wf" + (cursor ? " AND createdAt < :c" : ""),
          ExpressionAttributeValues: cursor
            ? { ":wf": workflowName, ":c": Number(cursor) }
            : { ":wf": workflowName },
          ScanIndexForward: false, // newest first
          Limit: limit + 1,
        };
        const { Items } = await dyn.send(new QueryCommand(q));
        const values = (Items ?? []).slice(0, limit);
        return {
          data: values.map(compact) as WorkflowRun[],
          hasMore: (Items?.length ?? 0) > limit,
          cursor: values.at(-1)?.createdAt ?? null,
        };
      }

      // If status provided:
      if (status) {
        const q = {
          TableName: TABLE_NAME,
          IndexName: "statusIndex",
          KeyConditionExpression:
            "status = :s" + (cursor ? " AND createdAt < :c" : ""),
          ExpressionAttributeValues: cursor
            ? { ":s": status, ":c": Number(cursor) }
            : { ":s": status },
          ScanIndexForward: false,
          Limit: limit + 1,
        };
        const { Items } = await dyn.send(new QueryCommand(q));
        const values = (Items ?? []).slice(0, limit);
        return {
          data: values.map(compact) as WorkflowRun[],
          hasMore: (Items?.length ?? 0) > limit,
          cursor: values.at(-1)?.createdAt ?? null,
        };
      }

      const { Items } = await dyn.send(
        new QueryCommand({
          TableName: TABLE_NAME,
          IndexName: "entityTypeIndex",
          KeyConditionExpression:
            "entityType = :t" + (cursor ? " AND createdAt < :c" : ""),
          ExpressionAttributeValues: cursor
            ? { ":t": "Run", ":c": Number(cursor) }
            : { ":t": "Run" },
          ScanIndexForward: false,
          Limit: limit + 1,
        })
      );
      const values = (Items ?? []).slice(0, limit);
      return {
        data: values.map(compact) as WorkflowRun[],
        hasMore: (Items?.length ?? 0) > limit,
        cursor: values.at(-1)?.createdAt ?? null,
      };
    },

    async create(data) {
      const id = `${ULID_PREFIX_RUN}${ulid()}`;
      const PK = runPK(id);
      const SK = runMetaSK();
      const now = nowMs();
      const item = {
        PK,
        SK,
        entityType: "Run",
        runId: id,
        workflowName: data.workflowName,
        input: data.input,
        executionContext: data.executionContext ?? null,
        deploymentId: data.deploymentId,
        status: "pending",
        createdAt: now,
        updatedAt: now,
      };

      // conditional put - fail if already exists
      const params = {
        TableName: TABLE_NAME,
        Item: item,
        ConditionExpression: "attribute_not_exists(PK)",
      };
      try {
        await dyn.send(new PutCommand(params));
        return compact(item) as unknown as WorkflowRun;
      } catch (err: any) {
        throw new WorkflowAPIError(`Run ${id} already exists`, { status: 409 });
      }
    },

    async update(id, data) {
      // We need to read current metadata to decide about startedAt/completedAt
      const Key = { PK: runPK(id), SK: runMetaSK() };
      const { Item: current } = await dyn.send(
        new GetCommand({ TableName: TABLE_NAME, Key })
      );
      if (!current)
        throw new WorkflowAPIError(`Run not found: ${id}`, { status: 404 });

      const now = nowMs();
      const ExpressionAttributeNames: Record<string, string> = {};
      const ExpressionAttributeValues: Record<string, any> = {};
      const setParts: string[] = [];

      // copy over allowed updatable fields from data
      for (const k of [
        "status",
        "output",
        "error",
        "errorCode",
        "deploymentId",
        "executionContext",
      ]) {
        if ((data as any)[k] !== undefined) {
          const name = `#${k}`;
          const val = `:${k}`;
          ExpressionAttributeNames[name] = k;
          ExpressionAttributeValues[val] = (data as any)[k];
          setParts.push(`${name} = ${val}`);
        }
      }

      // startedAt logic
      if ((data as any).status === "running" && !current.startedAt) {
        ExpressionAttributeNames["#startedAt"] = "startedAt";
        ExpressionAttributeValues[":startedAt"] = now;
        setParts.push("#startedAt = :startedAt");
      }

      // completedAt logic
      if (["completed", "failed", "cancelled"].includes((data as any).status)) {
        ExpressionAttributeNames["#completedAt"] = "completedAt";
        ExpressionAttributeValues[":completedAt"] = now;
        setParts.push("#completedAt = :completedAt");
      }

      // updatedAt always update
      ExpressionAttributeNames["#updatedAt"] = "updatedAt";
      ExpressionAttributeValues[":updatedAt"] = now;
      setParts.push("#updatedAt = :updatedAt");

      if (setParts.length === 0) {
        // nothing to update
        return compact(current) as WorkflowRun;
      }

      const updateExpr = "SET " + setParts.join(", ");

      const { Attributes } = await dyn.send(
        new UpdateCommand({
          TableName: TABLE_NAME,
          Key,
          UpdateExpression: updateExpr,
          ExpressionAttributeNames,
          ExpressionAttributeValues,
          ReturnValues: "ALL_NEW",
        })
      );
      if (!Attributes)
        throw new WorkflowAPIError(`Run not found: ${id}`, { status: 404 });
      return compact(Attributes as WorkflowRun);
    },
  };
}

export function createStepsStorage(
  dyn: DynamoDBDocumentClient,
  TABLE_NAME: string
): Storage["steps"] {
  const ulid = monotonicFactory();

  return {
    async create(runId, data) {
      const stepId = data.stepId ?? `${ULID_PREFIX_STEP}${ulid()}`;
      const PK = runPK(runId);
      const SK = stepSK(stepId);
      const now = nowMs();
      const item = {
        PK,
        SK,
        entityType: "Step",
        runId,
        stepId,
        stepName: data.stepName,
        input: data.input,
        status: "pending",
        attempt: 1,
        createdAt: now,
        updatedAt: now,
      };
      const params = {
        TableName: TABLE_NAME,
        Item: item,
        ConditionExpression:
          "attribute_not_exists(PK) AND attribute_not_exists(SK)",
      };
      try {
        await dyn.send(new PutCommand(params));
        return compact(item) as unknown as Step;
      } catch (err: any) {
        throw new WorkflowAPIError(`Step ${stepId} already exists`, {
          status: 409,
        });
      }
    },

    async get(runId, stepId) {
      if (!runId) {
        throw new WorkflowAPIError(`Run not found: ${runId}`, { status: 404 });
      }

      const Key = { PK: runPK(runId), SK: stepSK(stepId) };
      const { Item } = await dyn.send(
        new GetCommand({ TableName: TABLE_NAME, Key })
      );
      if (!Item)
        throw new WorkflowAPIError(`Step not found: ${stepId}`, {
          status: 404,
        });
      return compact(Item) as unknown as Step;
    },

    async update(runId, stepId, data) {
      // read current to check startedAt
      const Key = { PK: runPK(runId), SK: stepSK(stepId) };
      const { Item: current } = await dyn.send(
        new GetCommand({ TableName: TABLE_NAME, Key })
      );
      if (!current)
        throw new WorkflowAPIError(`Step not found: ${stepId}`, {
          status: 404,
        });

      const now = nowMs();
      const ExpressionAttributeNames: any = {};
      const ExpressionAttributeValues: any = {};
      const setParts: string[] = [];

      for (const k of ["status", "output", "error", "errorCode", "attempt"]) {
        if ((data as any)[k] !== undefined) {
          const name = `#${k}`;
          const val = `:${k}`;
          ExpressionAttributeNames[name] = k;
          ExpressionAttributeValues[val] = (data as any)[k];
          setParts.push(`${name} = ${val}`);
        }
      }

      if ((data as any).status === "running" && !current.startedAt) {
        ExpressionAttributeNames["#startedAt"] = "startedAt";
        ExpressionAttributeValues[":startedAt"] = now;
        setParts.push("#startedAt = :startedAt");
      }

      if (["completed", "failed"].includes((data as any).status)) {
        ExpressionAttributeNames["#completedAt"] = "completedAt";
        ExpressionAttributeValues[":completedAt"] = now;
        setParts.push("#completedAt = :completedAt");
      }

      ExpressionAttributeNames["#updatedAt"] = "updatedAt";
      ExpressionAttributeValues[":updatedAt"] = now;
      setParts.push("#updatedAt = :updatedAt");

      const { Attributes } = await dyn.send(
        new UpdateCommand({
          TableName: TABLE_NAME,
          Key,
          UpdateExpression: "SET " + setParts.join(", "),
          ExpressionAttributeNames,
          ExpressionAttributeValues,
          ReturnValues: "ALL_NEW",
        })
      );
      if (!Attributes)
        throw new WorkflowAPIError(`Step not found: ${stepId}`, {
          status: 404,
        });
      return compact(Attributes) as unknown as Step;
    },

    async list(params) {
      const limit = params?.pagination?.limit ?? 20;
      const cursor = params?.pagination?.cursor; // stepId cursor
      const pk = runPK(params.runId);
      let KeyConditionExpression = "PK = :pk";
      const ExpressionAttributeValues: any = { ":pk": pk };
      if (cursor) {
        KeyConditionExpression += " AND SK < :c";
        ExpressionAttributeValues[":c"] = stepSK(cursor);
      }
      const q = {
        TableName: TABLE_NAME,
        KeyConditionExpression,
        ExpressionAttributeValues,
        ScanIndexForward: false, // newest first by SK (ULID)
        Limit: limit + 1,
      };
      const { Items } = await dyn.send(new QueryCommand(q));
      const values = (Items ?? [])
        .filter((item) => item.entityType === "Step")
        .slice(0, limit);
      return {
        data: values.map(compact) as Step[],
        hasMore: (Items?.length ?? 0) > limit,
        cursor: values.at(-1)?.stepId ?? null,
      };
    },
  };
}

export function createHooksStorage(
  dyn: DynamoDBDocumentClient,
  TABLE_NAME: string
): Storage["hooks"] {
  return {
    async get(hookId) {
      // HookId unknown runId -> if you always know runId use GET; otherwise you need a global index by hookId
      // We'll assume hookId is unique and we have a GSI hookIdIndex(hash=hookId, range=PK)
      const q = {
        TableName: TABLE_NAME,
        IndexName: "hookIdIndex",
        KeyConditionExpression: "hookId = :hid",
        ExpressionAttributeValues: { ":hid": hookId },
        Limit: 1,
      };
      const { Items } = await dyn.send(new QueryCommand(q));
      const item = Items?.[0];

      if (!item) {
        throw new WorkflowAPIError(`Hook not found: ${hookId}`, {
          status: 404,
        });
      }
      return compact(item) as Hook;
    },

    async create(runId, data) {
      const PK = runPK(runId);
      const SK = hookSK(data.hookId);
      const now = nowMs();
      const item = {
        PK,
        SK,
        entityType: "Hook",
        runId,
        hookId: data.hookId,
        token: data.token,
        ownerId: "",
        projectId: "",
        environment: "",
        createdAt: now,
      };
      const params = {
        TableName: TABLE_NAME,
        Item: item,
        ConditionExpression:
          "attribute_not_exists(PK) AND attribute_not_exists(SK)",
      };
      try {
        await dyn.send(new PutCommand(params));
        return compact(item) as unknown as Hook;
      } catch (err: any) {
        throw new WorkflowAPIError(`Hook ${data.hookId} already exists`, {
          status: 409,
        });
      }
    },

    async getByToken(token) {
      const q = {
        TableName: TABLE_NAME,
        IndexName: "tokenIndex",
        KeyConditionExpression: "#token = :t",
        ExpressionAttributeNames: { "#token": "token" },
        ExpressionAttributeValues: { ":t": token },
        Limit: 1,
      };
      const { Items } = await dyn.send(new QueryCommand(q)).catch((err) => {
        console.log("Error", err);
        return { Items: [] };
      });

      console.log("Items", Items);

      if (!Items || Items.length === 0)
        throw new WorkflowAPIError(`Hook not found for token: ${token}`, {
          status: 404,
        });
      return compact(Items[0]) as unknown as Hook;
    },

    async list(params) {
      const limit = params?.pagination?.limit ?? 100;
      const cursor = params?.pagination?.cursor;
      // If runId provided, list under that run
      if (params.runId) {
        const KeyConditionExpression = cursor
          ? "PK = :pk AND SK < :c"
          : "PK = :pk";
        const ExpressionAttributeValues: any = { ":pk": runPK(params.runId) };
        if (cursor) ExpressionAttributeValues[":c"] = hookSK(cursor);
        const q = {
          TableName: TABLE_NAME,
          KeyConditionExpression,
          ExpressionAttributeValues,
          ScanIndexForward: false,
          Limit: limit + 1,
        };
        const { Items } = await dyn.send(new QueryCommand(q));
        const values = (Items ?? [])
          .filter((item) => item.entityType === "Hook")
          .slice(0, limit);
        return {
          data: values.map(compact) as Hook[],
          cursor: values.at(-1)?.hookId ?? null,
          hasMore: (Items?.length ?? 0) > limit,
        };
      } else {
        // list globally via typeIndex entityType='Hook'
        const q = {
          TableName: TABLE_NAME,
          IndexName: "entityTypeIndex",
          KeyConditionExpression:
            "entityType = :t" + (cursor ? " AND createdAt < :c" : ""),
          ExpressionAttributeValues: cursor
            ? { ":t": "Hook", ":c": Number(cursor) }
            : { ":t": "Hook" },
          ScanIndexForward: false,
          Limit: limit + 1,
        };
        const { Items } = await dyn.send(new QueryCommand(q));
        const values = (Items ?? [])
          .filter((item) => item.entityType === "Hook")
          .slice(0, limit);
        return {
          data: values.map(compact) as Hook[],
          cursor: values.at(-1)?.createdAt ?? null,
          hasMore: (Items?.length ?? 0) > limit,
        };
      }
    },

    async dispose(hookId) {
      // Delete by hookIdIndex -> get its PK/SK then delete
      const q = {
        TableName: TABLE_NAME,
        IndexName: "hookIdIndex",
        KeyConditionExpression: "hookId = :hid",
        ExpressionAttributeValues: { ":hid": hookId },
        Limit: 1,
      };
      const { Items } = await dyn.send(new QueryCommand(q));
      if (!Items || Items.length === 0)
        throw new WorkflowAPIError(`Hook not found: ${hookId}`, {
          status: 404,
        });
      const item = Items[0];
      const { Attributes } = await dyn.send(
        new DeleteCommand({
          TableName: TABLE_NAME,
          Key: { PK: item.PK, SK: item.SK },
          ReturnValues: "ALL_OLD",
        })
      );
      if (!Attributes)
        throw new WorkflowAPIError(`Hook not found: ${hookId}`, {
          status: 404,
        });
      return compact(Attributes) as unknown as Hook;
    },
  };
}

export function createEventsStorage(
  dyn: DynamoDBDocumentClient,
  TABLE_NAME: string
): Storage["events"] {
  const ulid = monotonicFactory();

  return {
    async create(runId, data) {
      const eventId = `${ULID_PREFIX_EVT}${ulid()}`;
      const PK = runPK(runId);
      const SK = eventSK(eventId);
      const now = nowMs();
      const item = {
        PK,
        SK,
        entityType: "Event",
        runId,
        eventId,
        correlationId: data.correlationId ?? null,
        eventType: data.eventType,
        eventData: "eventData" in data ? data.eventData : undefined,
        createdAt: now,
      };

      const params = {
        TableName: TABLE_NAME,
        Item: item,
        ConditionExpression:
          "attribute_not_exists(PK) AND attribute_not_exists(SK)",
      };
      try {
        await dyn.send(new PutCommand(params));
        return { ...compact(item) } as unknown as Event;
      } catch (err: any) {
        throw new WorkflowAPIError(`Event ${eventId} could not be created`, {
          status: 409,
        });
      }
    },

    async list(params) {
      const limit = params?.pagination?.limit ?? 100;
      const sortOrder = params.pagination?.sortOrder || "asc";
      const cursor = params.pagination?.cursor; // eventId or createdAt cursor

      // Query by run PK
      // If we want to use eventId ULID ordering, SK lexicographic compares. Dynamo KeyConditionExpression needs SK comparisons.
      // If using createdAt as attribute in sort key GSI, we could query that; for simplicity we compare SK (EVENT#ulid)
      const pk = runPK(params.runId);
      let KeyConditionExpression = "PK = :pk";
      const ExpressionAttributeValues: any = { ":pk": pk };
      if (cursor) {
        // if desc we want SK < eventSK(cursor), if asc then SK > eventSK(cursor)
        const op = sortOrder === "desc" ? "<" : ">";
        KeyConditionExpression += ` AND SK ${op} :cursor`;
        ExpressionAttributeValues[":cursor"] = eventSK(cursor);
      }

      // Dynamo requires the range comparator to be supported on the sort key,
      // which is true because SK is the sort key.
      const q = {
        TableName: TABLE_NAME,
        KeyConditionExpression,
        ExpressionAttributeValues,
        ScanIndexForward: sortOrder === "asc",
        Limit: limit + 1,
      };

      const { Items } = await dyn.send(new QueryCommand(q));
      const values = (Items ?? [])
        .filter((item) => item.entityType === "Event")
        .slice(0, limit);
      return {
        data: values.map(compact) as unknown as Event[],
        cursor: values.at(-1)?.eventId ?? null,
        hasMore: (Items?.length ?? 0) > limit,
      };
    },

    async listByCorrelationId(params) {
      const limit = params?.pagination?.limit ?? 100;
      const sortOrder = params.pagination?.sortOrder || "asc";
      const cursor = params.pagination?.cursor;

      // Query correlationIndex (hash=correlationId, range=createdAt)
      // The sort key is createdAt, so we use createdAt for cursor filtering
      const q: any = {
        TableName: TABLE_NAME,
        IndexName: "correlationIndex",
        KeyConditionExpression: "correlationId = :cid",
        ExpressionAttributeValues: { ":cid": params.correlationId },
        ScanIndexForward: sortOrder === "asc",
        Limit: limit + 1,
      };
      if (cursor) {
        // cursor is a timestamp (createdAt) from previous page
        q.KeyConditionExpression += " AND createdAt > :c";
        q.ExpressionAttributeValues[":c"] = Number(cursor);
        if (sortOrder === "desc") {
          q.KeyConditionExpression = "correlationId = :cid AND createdAt < :c";
        }
      }

      const { Items } = await dyn.send(new QueryCommand(q));
      const values = (Items ?? [])
        .filter((item) => item.entityType === "Event")
        .slice(0, limit);
      return {
        data: values.map(compact) as Event[],
        cursor: values.at(-1)?.createdAt ?? null,
        hasMore: (Items?.length ?? 0) > limit,
      };
    },
  };
}

export function compact<T extends object>(obj: T) {
  const value = {} as {
    [key in keyof T]: null extends T[key]
      ? undefined | NonNullable<T[key]>
      : T[key];
  };
  for (const key in obj) {
    if (obj[key] !== null) {
      // Convert timestamp fields to Date objects
      if (
        (key === "createdAt" ||
          key === "updatedAt" ||
          key === "startedAt" ||
          key === "completedAt") &&
        typeof obj[key] === "number"
      ) {
        value[key] = new Date(obj[key] as number) as any;
      } else {
        value[key] = obj[key] as any;
      }
    } else {
      value[key] = undefined as any;
    }
  }
  return value;
}

export function loggerProxy<T extends Record<string, (...args: any[]) => any>>(
  obj: T,
  prefix = ""
): T {
  // something that we can use like so:
  // const runs = loggerProxy(createRunsStorage(tableName));
  // runs.get("123") // -> prints "Calling 'get' with id '123', result: { ... }"

  return new Proxy(obj, {
    get(target, prop: string | symbol) {
      return async (
        ...args: Parameters<(typeof target)[keyof typeof target]>
      ) => {
        console.log(
          `Calling ${prefix}.${String(prop)} with args: ${JSON.stringify(args)}`
        );
        const result = await target[prop as keyof typeof target](...args);
        console.log(
          `${prefix}.${String(prop)} result: ${JSON.stringify(result)}`
        );
        return result as ReturnType<(typeof target)[keyof typeof target]>;
      };
    },
  }) as typeof obj;
}
