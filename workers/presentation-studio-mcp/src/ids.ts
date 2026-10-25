import { randomHex } from "./crypto";

export function randomId(): string {
  return crypto.randomUUID();
}

export function randomWorkflowRunId(): string {
  return "wf_" + randomId();
}

export function randomSeed(): string {
  return randomHex(16);
}
