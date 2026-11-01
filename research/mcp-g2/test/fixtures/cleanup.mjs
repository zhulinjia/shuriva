/** Teardown failure must not skip remaining owned resources or hide an earlier error. */
export async function closeOwnedDatabase(endPool, dropSchema, endAdmin) {
  const failures = [];
  for (const operation of [endPool, dropSchema, endAdmin]) {
    try {
      await operation();
    } catch (error) {
      failures.push(error);
    }
  }
  if (failures.length) throw new AggregateError(failures, "G2_DATABASE_CLEANUP_FAILED");
}
