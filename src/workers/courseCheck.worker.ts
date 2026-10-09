/// <reference lib="webworker" />
/**
 * Course-editor validation off the main thread: a course with a gate through the net or a blocked
 * corridor sends the racing line into many A* detours (seconds of work), which would freeze the
 * editor after every edit. Answers one check request at a time; the editor terminates the worker
 * when a newer edit supersedes the running check.
 */
import { runChecks, type CheckReply, type CheckRequest } from '../app/panels/courseEditorUtils';

const scope = self as unknown as DedicatedWorkerGlobalScope;
scope.onmessage = (e: MessageEvent<CheckRequest>) => {
  const { id, course, opts } = e.data;
  let reply: CheckReply;
  try {
    reply = { id, result: runChecks(course, opts) };
  } catch (err) {
    reply = { id, error: err instanceof Error ? err.message : String(err) };
  }
  scope.postMessage(reply);
};
