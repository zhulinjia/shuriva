import assert from "node:assert/strict";
import { test } from "node:test";
import { cellDisplay, compareResultCells, resultChartData } from "../src/queries/result-presentation.ts";

const text = (value) => ({ null: false, encoding: "text", value });
const binary = (value) => ({ null: false, encoding: "base64", value });
const empty = { null: true };
const fixture = (rows) => ({
  columns: [
    { name: "city", type: "VARCHAR" },
    { name: "balance", type: "DECIMAL" },
  ],
  rows,
  timezone: "UTC",
  truncated: false,
});
const definition = { kind: "bar", x: "city", y: "balance" };

test("table ordering preserves large integer and decimal precision, signs and scientific values", () => {
  const values = [
    "9007199254740993",
    "9007199254740992",
    "-100.25",
    "0",
    "-0.0001",
    "100.000000000000000002",
    "100.000000000000000001",
    "1e-3",
  ];
  assert.deepEqual(
    values
      .map(text)
      .sort((a, b) => compareResultCells(a, b, "DECIMAL"))
      .map((cell) => cell.value),
    [
      "-100.25",
      "-0.0001",
      "0",
      "1e-3",
      "100.000000000000000001",
      "100.000000000000000002",
      "9007199254740992",
      "9007199254740993",
    ],
  );
  assert.equal(compareResultCells(text("1.00"), text("1"), "DECIMAL"), 0);
  assert.equal(compareResultCells(text("-0"), text("0"), "DECIMAL"), 0);
  assert.equal(compareResultCells(text("100"), text("2"), "VARCHAR"), -1);
});

test("null, binary and invalid numeric cells have a deterministic distinct ordering and display", () => {
  const values = [binary("AA=="), text("invalid"), text("2"), empty, text("")];
  const sorted = values.toSorted((a, b) => compareResultCells(a, b, "INT"));
  assert.deepEqual(sorted, [empty, text("2"), text(""), text("invalid"), binary("AA==")]);
  assert.equal(cellDisplay(empty), "NULL");
  assert.equal(cellDisplay(text("")), "（空文本）");
  assert.equal(cellDisplay(binary("AA==")), "Base64: AA==");
});

test("charts retain one point per returned row and preserve exact tooltip values and null gaps", () => {
  const result = fixture([
    [text("上海"), text("120.50")],
    [text("上海"), text("80.00")],
    [text("北京"), empty],
  ]);
  const chart = resultChartData(result, definition);
  assert.equal(chart.ok, true);
  assert.deepEqual(chart.points, [
    { label: "上海", value: 120.5, exactValue: "120.50" },
    { label: "上海", value: 80, exactValue: "80.00" },
    { label: "北京", value: null, exactValue: "NULL" },
  ]);
  assert.equal(chart.nullCount, 1);
  assert.deepEqual(result.rows[0], [text("上海"), text("120.50")]);
});

test("charts reject precision loss, unknown fields and nonnumeric or binary content without changing results", () => {
  for (const value of [
    "9007199254740993",
    "0.100000000000000001",
    "not-a-number",
    "1e9999",
    "1e-9999",
  ]) {
    const result = fixture([[text("上海"), text(value)]]);
    assert.equal(resultChartData(result, definition).ok, false);
    assert.equal(result.rows[0][1].value, value);
  }
  const result = fixture([[text("上海"), text("120.50")]]);
  assert.equal(resultChartData(result, { ...definition, y: "missing" }).ok, false);
  assert.equal(
    resultChartData(
      { ...result, columns: [result.columns[0], { name: "balance", type: "VARCHAR" }] },
      definition,
    ).ok,
    false,
  );
  assert.equal(resultChartData(fixture([[binary("AA=="), text("1")]]), definition).ok, false);
  assert.equal(resultChartData(fixture([[text("上海"), binary("AA==")]]), definition).ok, false);
  assert.equal(
    resultChartData({ ...result, columns: [...result.columns, result.columns[1]] }, definition).ok,
    false,
  );
  assert.equal(
    resultChartData(
      fixture(Array.from({ length: 501 }, () => [text("上海"), text("1")])),
      definition,
    ).ok,
    false,
  );
  assert.equal(resultChartData(fixture([]), definition).ok, false);
  assert.equal(resultChartData(fixture([[text("上海"), empty]]), definition).ok, false);
});
