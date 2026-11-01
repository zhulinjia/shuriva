package main

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"time"

	"example.com/stackoryn/research/controlled-writes-g2/internal/lab"
)

func run() error {
	if len(os.Args) != 3 || (os.Args[1] != "inspect" && os.Args[1] != "shutdown") {
		return fmt.Errorf("usage: fixturectl inspect|shutdown explicit-manifest-path")
	}
	m, err := lab.Load(os.Args[2])
	if err != nil {
		return err
	}
	db, err := lab.Open(m)
	if err != nil {
		return err
	}
	defer db.Close()
	ctx, cancel := context.WithTimeout(context.Background(), 8*time.Second)
	defer cancel()
	if err := db.PingContext(ctx); err != nil {
		return err
	}
	if os.Args[1] == "shutdown" {
		_, err := db.ExecContext(ctx, "SHUTDOWN")
		return err
	}
	var version string
	if err := db.QueryRowContext(ctx, "SELECT VERSION()").Scan(&version); err != nil {
		return fmt.Errorf("cannot inspect isolated server version")
	}
	var schemas, accounts int
	if err := db.QueryRowContext(ctx, "SELECT COUNT(*) FROM information_schema.SCHEMATA WHERE LEFT(SCHEMA_NAME,10)='stage8_g2_' OR LEFT(SCHEMA_NAME,11)='g3_mut_api_' OR LEFT(SCHEMA_NAME,16)='stackoryn_write_'").Scan(&schemas); err != nil {
		return fmt.Errorf("cannot count experiment schemas")
	}
	if err := db.QueryRowContext(ctx, "SELECT COUNT(*) FROM mysql.user WHERE LEFT(User,5) IN ('s8g2_','s8g3_') OR LEFT(User,9)='st_write_'").Scan(&accounts); err != nil {
		return fmt.Errorf("cannot count experiment accounts")
	}
	return json.NewEncoder(os.Stdout).Encode(map[string]any{
		"verified": true, "version": version, "port": m.Port,
		"serverUuid": m.ServerUUID, "dataDir": m.DataDir, "ownerPid": m.OwnerPID,
		"remainingExperimentSchemas": schemas, "remainingExperimentAccounts": accounts,
	})
}

func main() {
	if err := run(); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}
