package mutationmysql

import (
	"context"
	"database/sql"
	"strings"
)

// CaptureInstallation may only be run by the trusted offline installer after
// executing the reviewed plan. It checks template bodies before pinning them;
// reading arbitrary existing definitions is never trust enrollment.
func CaptureInstallation(ctx context.Context, db *sql.DB, p InstallPlan) (Manifest, error) {
	var m Manifest
	reader, err := db.BeginTx(ctx, &sql.TxOptions{Isolation: sql.LevelReadCommitted, ReadOnly: true})
	if err != nil {
		return m, ErrInstallation
	}
	defer reader.Rollback()
	var mandatory, active string
	var roles, flush int
	if err := reader.QueryRowContext(ctx, "SELECT @@server_uuid,@@version,@@lower_case_table_names,@@global.mandatory_roles,@@global.activate_all_roles_on_login,CURRENT_ROLE(),@@innodb_flush_log_at_trx_commit").Scan(&m.ServerUUID, &m.ServerVersion, &m.LowerCase, &mandatory, &roles, &active, &flush); err != nil || m.ServerVersion != "26.7.0" || m.LowerCase != 1 || mandatory != "" || roles != 0 || active != "NONE" || flush != 1 {
		return m, ErrInstallation
	}
	regenerated, err := BuildInstallation(p.Spec)
	if err != nil || regenerated.ControlCatalog != p.ControlCatalog || templateHash(regenerated) != templateHash(p) {
		return m, ErrInstallation
	}
	m.Format = "stackoryn-mutation-installation-v1"
	m.Spec = p.Spec
	m.ControlCatalog = p.ControlCatalog
	m.Definer = p.Definer
	m.TemplateHash = templateHash(p)
	m.Definitions = map[string]Definition{}
	m.DefinerGrants = expectedGrants(p, p.Definer, "definer")
	m.WriterGrants = expectedGrants(p, p.Spec.Writer, "writer")
	m.RecoveryGrants = expectedGrants(p, p.Spec.Recovery, "recovery")
	var locked string
	if reader.QueryRowContext(ctx, "SELECT account_locked FROM mysql.user WHERE User=? AND Host=?", p.Definer.User, p.Definer.Host).Scan(&locked) != nil || locked != "Y" {
		return Manifest{}, ErrInstallation
	}
	for _, entry := range []struct {
		who    Account
		grants []string
	}{{p.Definer, m.DefinerGrants}, {p.Spec.Writer, m.WriterGrants}, {p.Spec.Recovery, m.RecoveryGrants}} {
		rows, err := reader.QueryContext(ctx, "SHOW GRANTS FOR "+account(entry.who))
		if err != nil {
			return Manifest{}, ErrInstallation
		}
		var found []string
		for rows.Next() {
			var grant string
			if rows.Scan(&grant) != nil {
				rows.Close()
				return Manifest{}, ErrInstallation
			}
			found = append(found, grant)
		}
		err = rows.Err()
		rows.Close()
		if err != nil || !sameStrings(found, entry.grants) {
			return Manifest{}, ErrInstallation
		}
	}
	for _, r := range p.Routines {
		// SHOW CREATE first retains this routine's MDL for the read-only
		// capture transaction, so the subsequent body/parameter check cannot
		// enroll a concurrently replaced definition.
		var d Definition
		if err := reader.QueryRowContext(ctx, "SHOW CREATE PROCEDURE "+qualified(p.ControlCatalog, r.Name)).Scan(&d.Name, &d.SQLMode, &d.CreateSQL, &d.Charset, &d.Collation, &d.DatabaseCollation); err != nil || d.CreateSQL == "" {
			return Manifest{}, ErrInstallation
		}
		var body, owner, security, access string
		err := reader.QueryRowContext(ctx, "SELECT ROUTINE_DEFINITION,DEFINER,SECURITY_TYPE,SQL_DATA_ACCESS FROM information_schema.ROUTINES WHERE ROUTINE_SCHEMA=? AND ROUTINE_NAME=? AND ROUTINE_TYPE='PROCEDURE'", p.ControlCatalog, r.Name).Scan(&body, &owner, &security, &access)
		if err != nil || body != r.Body || owner != p.Definer.User+"@"+p.Definer.Host || security != "DEFINER" || access != r.Access {
			return Manifest{}, ErrInstallation
		}
		parameters, err := reader.QueryContext(ctx, "SELECT PARAMETER_MODE,PARAMETER_NAME,DTD_IDENTIFIER,ORDINAL_POSITION FROM information_schema.PARAMETERS WHERE SPECIFIC_SCHEMA=? AND SPECIFIC_NAME=? ORDER BY ORDINAL_POSITION", p.ControlCatalog, r.Name)
		if err != nil {
			return Manifest{}, ErrInstallation
		}
		var expected []string
		if r.Parameters != "" {
			expected = strings.Split(r.Parameters, ",")
		}
		position := 0
		for parameters.Next() {
			var mode, name, dtype string
			var ordinal int
			if parameters.Scan(&mode, &name, &dtype, &ordinal) != nil || position >= len(expected) || ordinal != position+1 {
				parameters.Close()
				return Manifest{}, ErrInstallation
			}
			parts := strings.Fields(strings.TrimSpace(expected[position]))
			if len(parts) != 3 || mode != parts[0] || name != parts[1] || strings.ToLower(dtype) != strings.ToLower(parts[2]) {
				parameters.Close()
				return Manifest{}, ErrInstallation
			}
			position++
		}
		err = parameters.Err()
		parameters.Close()
		if err != nil || position != len(expected) {
			return Manifest{}, ErrInstallation
		}
		m.Definitions[r.Name] = d
	}
	m.ControlDefinitions = map[string]string{}
	checker := &Controller{manifest: m}
	for _, name := range []string{"gate", "receipts"} {
		proof, err := checker.inspect(ctx, reader, p.ControlCatalog, name)
		if err != nil || validateControl(name, proof) != nil {
			return Manifest{}, ErrInstallation
		}
		m.ControlDefinitions[name] = proof.definition
	}
	return m, nil
}
