import assert from "node:assert/strict";
import { test } from "node:test";
import {
  confirmSemanticLeave,
  semanticEntryKey,
  updateSemanticEntry,
} from "../src/semantic-editor.ts";

test("editing follows the physical entry after a reorder and never replaces a different entry after removal", () => {
  const first = { name: "first", table: "customers", column: "id" };
  const second = { name: "second", table: "customers", column: "name" };
  const editing = semanticEntryKey(first);
  const updated = { ...first, name: "new label" };
  assert.deepEqual(updateSemanticEntry([second, first], editing, updated), [second, updated]);
  assert.throws(() => updateSemanticEntry([second], editing, updated), /ENTRY_CHANGED/);
  assert.deepEqual(second, { name: "second", table: "customers", column: "name" });
});

test("renaming an entry cannot overwrite a duplicate, and identifier separators remain unambiguous", () => {
  const a = { name: "first", table: "a:b", column: "c" };
  const b = { name: "second", table: "a", column: "b:c" };
  assert.notEqual(semanticEntryKey(a), semanticEntryKey(b));
  assert.throws(() => updateSemanticEntry([a, b], semanticEntryKey(a), b), /DUPLICATE/);
  assert.deepEqual(updateSemanticEntry([a], null, b), [a, b]);
});

test("cancelling navigation preserves unsaved work and an active save cannot be discarded", () => {
  let confirmations = 0;
  let alerts = 0;
  const dialogs = {
    confirm: () => {
      confirmations++;
      return false;
    },
    alert: () => {
      alerts++;
    },
  };
  assert.equal(confirmSemanticLeave({ pending: false, busy: false }, dialogs), true);
  assert.equal(confirmations, 0);
  assert.equal(confirmSemanticLeave({ pending: true, busy: false }, dialogs), false);
  assert.equal(confirmations, 1);
  assert.equal(confirmSemanticLeave({ pending: true, busy: true }, dialogs), false);
  assert.equal(confirmations, 1);
  assert.equal(alerts, 1);
  assert.equal(
    confirmSemanticLeave({ pending: true, busy: false }, { ...dialogs, confirm: () => true }),
    true,
  );
});
