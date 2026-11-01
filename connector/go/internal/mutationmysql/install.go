// Package mutationmysql implements the trusted MySQL mutation boundary. SQL
// templates are operator installation artifacts, never accepted from a model.
package mutationmysql

import (
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"regexp"
	"sort"
	"strings"
	"unicode"
	"unicode/utf8"
)

var ErrInstallation = errors.New("mutation installation could not be verified")
var hex32 = regexp.MustCompile(`^[0-9a-f]{32}$`)
var uuid = regexp.MustCompile(`^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$`)
var hex64 = regexp.MustCompile(`^[0-9a-f]{64}$`)
var accountName = regexp.MustCompile(`^[a-zA-Z][a-zA-Z0-9_]{0,31}$`)

type Account struct {
	User string `json:"user"`
	Host string `json:"host"`
}
type InstallSpec struct {
	Catalog     string   `json:"catalog"`
	Tables      []string `json:"tables"`
	Writer      Account  `json:"writer"`
	Recovery    Account  `json:"recovery"`
	Incarnation string   `json:"incarnation"`
	Generation  string   `json:"generation"`
}
type Routine struct {
	Name       string `json:"name"`
	Parameters string `json:"parameters"`
	Body       string `json:"body"`
	Access     string `json:"access"`
}
type InstallPlan struct {
	Spec           InstallSpec `json:"spec"`
	ControlCatalog string      `json:"controlCatalog"`
	Definer        Account     `json:"definer"`
	Routines       []Routine   `json:"routines"`
	Statements     []string    `json:"statements"`
	InitialEpoch   string      `json:"initialEpoch"`
}
type Definition struct {
	Name              string `json:"name"`
	SQLMode           string `json:"sqlMode"`
	CreateSQL         string `json:"createSql"`
	Charset           string `json:"charset"`
	Collation         string `json:"collation"`
	DatabaseCollation string `json:"databaseCollation"`
}
type Manifest struct {
	Format             string                `json:"format"`
	Spec               InstallSpec           `json:"spec"`
	ControlCatalog     string                `json:"controlCatalog"`
	Definer            Account               `json:"definer"`
	ServerUUID         string                `json:"serverUuid"`
	ServerVersion      string                `json:"serverVersion"`
	LowerCase          int                   `json:"lowerCase"`
	Definitions        map[string]Definition `json:"definitions"`
	ControlDefinitions map[string]string     `json:"controlDefinitions"`
	DefinerGrants      []string              `json:"definerGrants"`
	WriterGrants       []string              `json:"writerGrants"`
	RecoveryGrants     []string              `json:"recoveryGrants"`
	TemplateHash       string                `json:"templateHash"`
}

func identifier(value string) bool {
	if value == "" || utf8.RuneCountInString(value) > 64 || !utf8.ValidString(value) {
		return false
	}
	for _, r := range value {
		if unicode.IsControl(r) || r == '\x00' {
			return false
		}
	}
	return true
}
func ident(value string) string { return "`" + strings.ReplaceAll(value, "`", "``") + "`" }
func literal(value string) string {
	return "CONVERT(0x" + hex.EncodeToString([]byte(value)) + " USING utf8mb4)"
}
func account(a Account) string      { return "'" + a.User + "'@'" + a.Host + "'" }
func grantAccount(a Account) string { return "`" + a.User + "`@`" + a.Host + "`" }
func validAccount(a Account) bool {
	return accountName.MatchString(a.User) && !strings.EqualFold(a.User, "root") && (a.Host == "localhost" || a.Host == "127.0.0.1" || a.Host == "::1")
}
func NewEpoch() (string, error) {
	var token [32]byte
	if _, err := rand.Read(token[:]); err != nil {
		return "", ErrInstallation
	}
	return hex.EncodeToString(token[:]), nil
}
func controlCatalog(catalog string) string {
	sum := sha256.Sum256([]byte(catalog))
	return "stackoryn_write_" + hex.EncodeToString(sum[:8])
}
func proofName(schema, table string) string {
	sum := sha256.Sum256([]byte(schema + "\x00" + table))
	return "inspect_" + hex.EncodeToString(sum[:8])
}
func qualified(schema, name string) string { return ident(schema) + "." + ident(name) }
func targetIdentity(m Manifest) string {
	sum := sha256.Sum256([]byte(m.ServerUUID + "\x00" + m.Spec.Catalog + "\x00" + m.Spec.Incarnation))
	return hex.EncodeToString(sum[:])
}
func (m Manifest) TargetIdentity() string { return targetIdentity(m) }

// BuildInstallation never connects to a server. It creates no passwords and
// does not reset/reuse an existing control schema. Accounts must be explicitly
// created by the DBA, independently from the Connector runtime.
func BuildInstallation(spec InstallSpec) (InstallPlan, error) {
	var p InstallPlan
	switch strings.ToLower(spec.Catalog) {
	case "mysql", "sys", "information_schema", "performance_schema":
		return p, ErrInstallation
	}
	if strings.HasPrefix(strings.ToLower(spec.Catalog), "stackoryn_write_") {
		return p, ErrInstallation
	}
	if !identifier(spec.Catalog) || spec.Catalog != strings.ToLower(spec.Catalog) || len(spec.Tables) == 0 || len(spec.Tables) > 32 || !validAccount(spec.Writer) || !validAccount(spec.Recovery) || spec.Writer == spec.Recovery || !hex64.MatchString(spec.Incarnation) || !hex64.MatchString(spec.Generation) {
		return p, ErrInstallation
	}
	spec.Tables = append([]string(nil), spec.Tables...)
	sort.Strings(spec.Tables)
	for i, t := range spec.Tables {
		if !identifier(t) || t != strings.ToLower(t) || (i > 0 && t == spec.Tables[i-1]) {
			return p, ErrInstallation
		}
	}
	control := controlCatalog(spec.Catalog)
	sum := sha256.Sum256([]byte(spec.Catalog))
	definer := Account{User: "st_write_" + hex.EncodeToString(sum[:8]), Host: "localhost"}
	epoch, err := NewEpoch()
	if err != nil {
		return p, err
	}
	p = InstallPlan{Spec: spec, ControlCatalog: control, Definer: definer, InitialEpoch: epoch}
	gate := qualified(control, "gate")
	receipts := qualified(control, "receipts")
	catalog := literal(spec.Catalog)
	incarnation := literal(spec.Incarnation)
	p.Statements = []string{"CREATE DATABASE " + ident(control) + " CHARACTER SET utf8mb4 COLLATE utf8mb4_bin", "CREATE USER " + account(definer) + " ACCOUNT LOCK", "GRANT REFERENCES, TRIGGER ON *.* TO " + account(definer), "CREATE TABLE " + gate + " (catalog VARBINARY(256) PRIMARY KEY,incarnation BINARY(64) NOT NULL,epoch BINARY(64) NOT NULL) ENGINE=InnoDB", "CREATE TABLE " + receipts + " (execution_id BINARY(36) PRIMARY KEY,commitment BINARY(32) NOT NULL,scope VARBINARY(1024) NOT NULL,target_epoch BINARY(64) NOT NULL,row_count SMALLINT UNSIGNED NOT NULL) ENGINE=InnoDB", "INSERT INTO " + gate + " VALUES (" + catalog + "," + incarnation + ",'" + epoch + "')", "GRANT SELECT, UPDATE ON " + gate + " TO " + account(definer), "GRANT SELECT, INSERT ON " + receipts + " TO " + account(definer)}
	getGate := "SELECT HEX(catalog) AS catalog,incarnation,epoch FROM " + gate + " WHERE catalog=" + catalog
	lockBody := "BEGIN DECLARE ignored_count INT; DECLARE actual_epoch BINARY(64); SELECT epoch INTO actual_epoch FROM " + gate + " WHERE catalog=" + catalog + " AND incarnation=" + incarnation + " FOR SHARE; IF p_epoch IS NULL OR actual_epoch IS NULL OR actual_epoch<>p_epoch THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='mutation epoch refused'; END IF; SELECT COUNT(*) INTO ignored_count FROM " + receipts + " WHERE execution_id=REPEAT('0',36); END"
	p.Routines = []Routine{{"read_gate", "", getGate, "READS SQL DATA"}, {"lock_gate", "IN p_epoch VARBINARY(64)", lockBody, "READS SQL DATA"}, {"rotate_gate", "IN p_expected VARBINARY(64),IN p_next VARBINARY(64)", "BEGIN DECLARE actual_epoch BINARY(64); SELECT epoch INTO actual_epoch FROM " + gate + " WHERE catalog=" + catalog + " AND incarnation=" + incarnation + " FOR UPDATE; IF p_expected IS NULL OR p_next IS NULL OR actual_epoch IS NULL OR OCTET_LENGTH(p_expected)<>64 OR OCTET_LENGTH(p_next)<>64 OR actual_epoch<>p_expected OR p_expected=p_next OR CONVERT(p_next USING ascii) NOT REGEXP '^[0-9a-f]{64}$' THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='mutation recovery barrier refused'; END IF; UPDATE " + gate + " SET epoch=p_next WHERE catalog=" + catalog + "; END", "MODIFIES SQL DATA"}, {"put_receipt", "IN p_id VARBINARY(36),IN p_commitment VARBINARY(32),IN p_scope VARBINARY(1024),IN p_epoch VARBINARY(64),IN p_count INT", "BEGIN DECLARE actual_epoch BINARY(64); SELECT epoch INTO actual_epoch FROM " + gate + " WHERE catalog=" + catalog + " AND incarnation=" + incarnation + " FOR SHARE; IF p_id IS NULL OR p_commitment IS NULL OR p_scope IS NULL OR p_epoch IS NULL OR p_count IS NULL OR OCTET_LENGTH(p_id)<>36 OR CONVERT(p_id USING ascii) NOT REGEXP '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' OR OCTET_LENGTH(p_commitment)<>32 OR OCTET_LENGTH(p_scope)=0 OR p_count<1 OR p_count>100 OR actual_epoch IS NULL OR actual_epoch<>p_epoch THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='mutation receipt refused'; END IF; INSERT INTO " + receipts + " VALUES (p_id,p_commitment,p_scope,p_epoch,p_count); END", "MODIFIES SQL DATA"}, {"get_receipt", "IN p_id VARBINARY(36),IN p_scope VARBINARY(1024)", "SELECT execution_id,HEX(commitment) AS commitment,scope,target_epoch,row_count FROM " + receipts + " WHERE execution_id=p_id AND scope=p_scope", "READS SQL DATA"}, {"list_receipts", "IN p_scope VARBINARY(1024),IN p_after VARBINARY(36)", "SELECT execution_id,HEX(commitment) AS commitment,scope,target_epoch,row_count FROM " + receipts + " WHERE scope=p_scope AND execution_id>p_after ORDER BY execution_id LIMIT 100", "READS SQL DATA"}}
	targets := [][2]string{{control, "gate"}, {control, "receipts"}}
	for _, table := range spec.Tables {
		targets = append(targets, [2]string{spec.Catalog, table})
	}
	for _, t := range targets {
		p.Routines = append(p.Routines, Routine{Name: proofName(t[0], t[1]), Access: "READS SQL DATA"})
	}
	for i := range p.Routines {
		if strings.HasPrefix(p.Routines[i].Name, "inspect_") {
			var target [2]string
			for _, t := range targets {
				if proofName(t[0], t[1]) == p.Routines[i].Name {
					target = t
					break
				}
			}
			p.Routines[i].Body = inspectionBody(p, target[0], target[1])
		}
	}
	for _, r := range p.Routines {
		p.Statements = append(p.Statements, "CREATE DEFINER="+account(definer)+" PROCEDURE "+qualified(control, r.Name)+"("+r.Parameters+") SQL SECURITY DEFINER "+r.Access+" "+r.Body, "GRANT EXECUTE ON PROCEDURE "+qualified(control, r.Name)+" TO "+account(definer))
	}
	for _, table := range spec.Tables {
		p.Statements = append(p.Statements, "GRANT SELECT, INSERT, UPDATE, DELETE ON "+qualified(spec.Catalog, table)+" TO "+account(spec.Writer))
	}
	for _, r := range p.Routines {
		if r.Name != "rotate_gate" {
			p.Statements = append(p.Statements, "GRANT EXECUTE ON PROCEDURE "+qualified(control, r.Name)+" TO "+account(spec.Writer))
		}
		if r.Name == "read_gate" || r.Name == "rotate_gate" || r.Name == "list_receipts" || r.Name == "get_receipt" || strings.HasPrefix(r.Name, "inspect_") {
			p.Statements = append(p.Statements, "GRANT EXECUTE ON PROCEDURE "+qualified(control, r.Name)+" TO "+account(spec.Recovery))
		}
	}
	return p, nil
}

func inspectionBody(p InstallPlan, schema, table string) string {
	s, t := literal(schema), literal(table)
	body := "BEGIN SHOW GRANTS FOR CURRENT_USER(); SELECT CURRENT_USER() AS proof_definer,@@server_uuid AS server_uuid,@@version AS server_version," + s + " AS target_schema," + t + " AS target_table,@@global.mandatory_roles AS mandatory_roles,@@global.activate_all_roles_on_login AS activate_all_roles_on_login,CURRENT_ROLE() AS active_roles; SELECT TABLE_TYPE,ENGINE FROM information_schema.TABLES WHERE BINARY TABLE_SCHEMA=BINARY " + s + " AND BINARY TABLE_NAME=BINARY " + t + "; SHOW CREATE TABLE " + qualified(schema, table) + "; SELECT COLUMN_NAME,DATA_TYPE,COLUMN_TYPE,IS_NULLABLE,COLUMN_DEFAULT,EXTRA,GENERATION_EXPRESSION,ORDINAL_POSITION,CHARACTER_MAXIMUM_LENGTH,NUMERIC_PRECISION,NUMERIC_SCALE,DATETIME_PRECISION FROM information_schema.COLUMNS WHERE BINARY TABLE_SCHEMA=BINARY " + s + " AND BINARY TABLE_NAME=BINARY " + t + " ORDER BY ORDINAL_POSITION; SELECT TRIGGER_NAME FROM information_schema.TRIGGERS WHERE BINARY EVENT_OBJECT_SCHEMA=BINARY " + s + " AND BINARY EVENT_OBJECT_TABLE=BINARY " + t + "; SELECT CONSTRAINT_NAME,COLUMN_NAME,REFERENCED_TABLE_SCHEMA,REFERENCED_TABLE_NAME FROM information_schema.KEY_COLUMN_USAGE WHERE BINARY REFERENCED_TABLE_SCHEMA=BINARY " + s + " AND BINARY REFERENCED_TABLE_NAME=BINARY " + t + "; SELECT CONSTRAINT_NAME,COLUMN_NAME,REFERENCED_TABLE_SCHEMA,REFERENCED_TABLE_NAME FROM information_schema.KEY_COLUMN_USAGE WHERE BINARY TABLE_SCHEMA=BINARY " + s + " AND BINARY TABLE_NAME=BINARY " + t + " AND REFERENCED_TABLE_NAME IS NOT NULL; SELECT CONSTRAINT_NAME FROM information_schema.TABLE_CONSTRAINTS WHERE BINARY TABLE_SCHEMA=BINARY " + s + " AND BINARY TABLE_NAME=BINARY " + t + " AND CONSTRAINT_TYPE='CHECK'; "
	for _, r := range p.Routines {
		body += "SHOW CREATE PROCEDURE " + qualified(p.ControlCatalog, r.Name) + "; "
	}
	return body + "SHOW GRANTS FOR CURRENT_USER(); SELECT @@global.mandatory_roles AS mandatory_roles,@@global.activate_all_roles_on_login AS activate_all_roles_on_login,CURRENT_ROLE() AS active_roles; END"
}

func expectedGrants(p InstallPlan, a Account, kind string) []string {
	to := " TO " + grantAccount(a)
	var out []string
	if kind == "definer" {
		out = append(out, "GRANT REFERENCES, TRIGGER ON *.*"+to, "GRANT SELECT, UPDATE ON "+qualified(p.ControlCatalog, "gate")+to, "GRANT SELECT, INSERT ON "+qualified(p.ControlCatalog, "receipts")+to)
	} else {
		out = append(out, "GRANT USAGE ON *.*"+to)
	}
	if kind == "writer" {
		for _, t := range p.Spec.Tables {
			out = append(out, "GRANT SELECT, INSERT, UPDATE, DELETE ON "+qualified(p.Spec.Catalog, t)+to)
		}
	}
	for _, r := range p.Routines {
		allowed := kind == "definer" || (kind == "writer" && r.Name != "rotate_gate") || (kind == "recovery" && (r.Name == "read_gate" || r.Name == "rotate_gate" || r.Name == "list_receipts" || r.Name == "get_receipt" || strings.HasPrefix(r.Name, "inspect_")))
		if allowed {
			out = append(out, "GRANT EXECUTE ON PROCEDURE "+qualified(p.ControlCatalog, r.Name)+to)
		}
	}
	sort.Strings(out)
	return out
}
func templateHash(p InstallPlan) string {
	raw, _ := json.Marshal(struct {
		Spec     InstallSpec
		Control  string
		Definer  Account
		Routines []Routine
	}{p.Spec, p.ControlCatalog, p.Definer, p.Routines})
	h := sha256.Sum256(raw)
	return hex.EncodeToString(h[:])
}
