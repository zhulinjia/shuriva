# Synthetic TLS peer fixtures

These self-signed certificates and their **publicly disclosed test private key**
are used only by ephemeral loopback protocol tests. They are not credentials for
any real service and must never be used in deployment. The test explicitly trusts
one fixture certificate and checks the actual configured IP against its SAN.

Generated on 2026-11-01 with OpenSSL, RSA 2048, validity 3650 days. `ip.pem` has
only `IP:127.0.0.1`; `localhost.pem` has only `DNS:localhost`. Regenerate before
expiry. The production adapter still uses the operating system trust store.
