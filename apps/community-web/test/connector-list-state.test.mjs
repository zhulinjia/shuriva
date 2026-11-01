import assert from "node:assert/strict";
import { test } from "node:test";
import {
  initialConnectorList,
  connectorListReducer as reduce,
  connectorStatus as status,
  connectorListView as view,
} from "../src/connector-list-state.ts";

const connector = {
  id: "fixture",
  name: "test",
  agentVersion: "test",
  lastSeenAt: 123,
  status: "online",
  diagnosticStatus: null,
};
const start = (state, request) => reduce(state, { type: "start", request });
const success = (state, request, items) => reduce(state, { type: "success", request, items });
const failure = (state, request) => reduce(state, { type: "failure", request });

test("refresh failure marks previously online status unknown and recovery restores it", () => {
  let state = success(start(initialConnectorList, 1), 1, [connector]);
  assert.equal(view(state), "items");
  assert.equal(status(state, connector), "online");
  state = failure(start(state, 2), 2);
  assert.equal(view(state), "items");
  assert.equal(state.refreshError, true);
  assert.equal(status(state, connector), "unknown");
  state = success(start(state, 3), 3, [connector]);
  assert.equal(state.refreshError, false);
  assert.equal(status(state, connector), "online");
});

test("older concurrent successes and failures never overwrite the newest result", () => {
  let state = start(start(initialConnectorList, 1), 2);
  state = failure(state, 2);
  state = success(state, 1, [connector]);
  assert.equal(view(state), "unavailable");
  state = success(start(state, 3), 3, [connector]);
  state = failure(state, 2);
  assert.equal(view(state), "items");
  assert.equal(status(state, connector), "online");
});

test("initial failure is unavailable, and an actually empty response is empty", () => {
  let state = failure(start(initialConnectorList, 1), 1);
  assert.equal(view(state), "unavailable");
  state = success(start(state, 2), 2, []);
  assert.equal(view(state), "empty");
  assert.equal(state.refreshError, false);
});
