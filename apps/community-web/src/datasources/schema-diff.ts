export type SchemaContent = {
  database: string;
  serverVersion: string;
  tables: Array<{ name: string; kind: string }>;
  columns: Array<{
    table: string;
    name: string;
    type: string;
    nullable: boolean;
    position: number;
  }>;
  relations: Array<{
    table: string;
    column: string;
    referencedTable: string;
    referencedColumn: string;
    constraint: string;
    position: number;
  }>;
  externalRelationsOmitted: number;
};

export function schemaChanges(current: SchemaContent, previous: SchemaContent): string[] {
  const changes: string[] = [];
  if (current.database !== previous.database)
    changes.push(`数据库名称变化：${previous.database} → ${current.database}`);
  const oldTables = new Map(previous.tables.map((table) => [table.name, table.kind]));
  const newTables = new Map(current.tables.map((table) => [table.name, table.kind]));
  for (const [name, kind] of newTables)
    if (!oldTables.has(name)) changes.push(`新增表或视图：${name}`);
    else if (oldTables.get(name) !== kind) changes.push(`对象类型变化：${name}`);
  for (const name of oldTables.keys())
    if (!newTables.has(name)) changes.push(`移除表或视图：${name}`);
  const key = (table: string, name: string) => JSON.stringify([table, name]);
  const oldColumns = new Map(
    previous.columns.map((column) => [key(column.table, column.name), column]),
  );
  const newColumns = new Map(
    current.columns.map((column) => [key(column.table, column.name), column]),
  );
  for (const [id, column] of newColumns) {
    const old = oldColumns.get(id);
    const label = `${column.table}.${column.name}`;
    if (!old) changes.push(`新增字段：${label}`);
    else if (
      old.type !== column.type ||
      old.nullable !== column.nullable ||
      old.position !== column.position
    )
      changes.push(`字段定义变化：${label}`);
  }
  for (const [id, column] of oldColumns)
    if (!newColumns.has(id)) changes.push(`移除字段：${column.table}.${column.name}`);
  const relationKey = (relation: SchemaContent["relations"][number]) =>
    JSON.stringify([
      relation.table,
      relation.column,
      relation.referencedTable,
      relation.referencedColumn,
      relation.constraint,
      relation.position,
    ]);
  const oldRelations = new Map(
    previous.relations.map((relation) => [relationKey(relation), relation]),
  );
  const newRelations = new Map(
    current.relations.map((relation) => [relationKey(relation), relation]),
  );
  for (const [id, relation] of newRelations)
    if (!oldRelations.has(id))
      changes.push(
        `新增关系：${relation.table}.${relation.column} → ${relation.referencedTable}.${relation.referencedColumn}`,
      );
  for (const [id, relation] of oldRelations)
    if (!newRelations.has(id))
      changes.push(
        `移除关系：${relation.table}.${relation.column} → ${relation.referencedTable}.${relation.referencedColumn}`,
      );
  if (current.externalRelationsOmitted !== previous.externalRelationsOmitted)
    changes.push("范围外关系的数量发生变化，具体目标未展示。");
  return [...new Set(changes)];
}
