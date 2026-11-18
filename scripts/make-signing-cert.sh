#!/bin/sh
# Makes a self-signed code signing certificate in your login Keychain, so every local
# build of DesktopJarvis is signed the same way. macOS then treats each new build as the
# same app and lets it keep reading the keys an earlier build saved. Run it once.
set -eu

NAME="DesktopJarvis Local Signing"
KEYCHAIN="$HOME/Library/Keychains/login.keychain-db"

if security find-identity -v -p codesigning | grep -q "$NAME"; then
  echo "\"$NAME\" is already set up."
  exit 0
fi

WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT

cat >"$WORK/cert.cnf" <<EOF
[req]
distinguished_name = dn
x509_extensions = ext
prompt = no
[dn]
CN = $NAME
[ext]
basicConstraints = critical, CA:false
keyUsage = critical, digitalSignature
extendedKeyUsage = critical, codeSigning
EOF

openssl req -x509 -newkey rsa:2048 -nodes -days 3650 -config "$WORK/cert.cnf" \
  -keyout "$WORK/key.pem" -out "$WORK/cert.pem" 2>/dev/null
openssl pkcs12 -export -inkey "$WORK/key.pem" -in "$WORK/cert.pem" -name "$NAME" \
  -passout pass:jarvis -out "$WORK/cert.p12"

security import "$WORK/cert.p12" -k "$KEYCHAIN" -P jarvis -T /usr/bin/codesign
# Trusting it for code signing asks for your login password.
security add-trusted-cert -r trustRoot -p codeSign -k "$KEYCHAIN" "$WORK/cert.pem"

echo "Made \"$NAME\". Builds from \`npm run app\` are now signed with it."
