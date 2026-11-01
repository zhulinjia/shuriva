import { randomBytes } from "node:crypto";
import mysql from "mysql2/promise";
import { migrateDatabase, migrateStage3 } from "../src/migrations.js";

/** Each test owns a fresh current schema; persistent review databases are never repaired. */
export async function createIsolatedDataSourceFixture(label: "binding" | "cross") {
  const options = {
    host: "127.0.0.1",
    port: 13307,
    user: "root",
    password: "stage3-isolated-fixture-only",
    timezone: "Z",
  };
  const admin = await mysql.createConnection(options);
  const database = `stage3_${label}_${randomBytes(8).toString("hex")}`;
  let platformCreated = false;
  let sourceDatabase: string | undefined;
  let reader: string | undefined;
  let pool: mysql.Pool | undefined;
  async function close() {
    await pool?.end();
    pool = undefined;
    try {
      if (sourceDatabase) await admin.query(`DROP DATABASE \`${sourceDatabase}\``);
      if (reader) await admin.query(`DROP USER '${reader}'@'127.0.0.1'`);
      if (platformCreated) await admin.query(`DROP DATABASE \`${database}\``);
    } finally {
      await admin.end();
    }
  }
  try {
    const [rows] = await admin.query<mysql.RowDataPacket[]>(
      "SELECT @@port AS port, @@datadir AS dir, @@partial_revokes AS partialRevokes",
    );
    if (
      rows[0]?.port !== 13307 ||
      !String(rows[0]?.dir)
        .toLowerCase()
        .replaceAll("\\", "/")
        .startsWith("i:/wwwroot/stackoryn-com/.cache/stage3-mysql-data/")
    )
      throw Error("unexpected isolated database instance");
    await admin.query(
      `CREATE DATABASE \`${database}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci`,
    );
    platformCreated = true;
    pool = mysql.createPool({ ...options, database, connectionLimit: 4 });
    await migrateDatabase(pool);
    await migrateStage3(pool);
    return {
      pool,
      async createMetadataSource() {
        if (sourceDatabase || reader) throw Error("metadata fixture already initialized");
        const source = `stage3_source_${randomBytes(8).toString("hex")}`;
        const username = `s3_${randomBytes(6).toString("hex")}`;
        const password = "stage3-reader-fixture-only";
        await admin.query(
          `CREATE DATABASE \`${source}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci`,
        );
        sourceDatabase = source;
        await admin.query(
          `CREATE TABLE \`${source}\`.customers (id BIGINT NOT NULL PRIMARY KEY,name VARCHAR(80) NOT NULL,status ENUM('active','inactive') NOT NULL) ENGINE=InnoDB`,
        );
        await admin.query(
          `CREATE TABLE \`${source}\`.orders (id BIGINT NOT NULL PRIMARY KEY,customer_id BIGINT NOT NULL,CONSTRAINT orders_customer_fk FOREIGN KEY (customer_id) REFERENCES \`${source}\`.customers(id)) ENGINE=InnoDB`,
        );
        await admin.query(
          `CREATE SQL SECURITY INVOKER VIEW \`${source}\`.customer_names AS SELECT id FROM \`${source}\`.customers`,
        );
        await admin.query(`CREATE USER '${username}'@'127.0.0.1' IDENTIFIED BY ?`, [password]);
        reader = username;
        const grantDatabase =
          Number(rows[0]?.partialRevokes) === 1 ? source : source.replaceAll("_", "\\_");
        await admin.query(
          `GRANT SELECT,SHOW VIEW ON \`${grantDatabase}\`.* TO '${username}'@'127.0.0.1'`,
        );
        return { database: source, username, password };
      },
      close,
    };
  } catch (error) {
    await close();
    throw error;
  }
}
