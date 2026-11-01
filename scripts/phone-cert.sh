#!/bin/bash
# The secure certificate for Yonna's iPhone page. iPhones allow the microphone
# only on secure (https) pages, so this Mac becomes its own small certificate
# authority, made once and kept in ~/Library/Application Support/Yonna/phone-tls:
#
#   yonna-ca.crt      install this on the iPhone once, then trust it
#   server.crt/.key   what the bridge serves https with
#
# The authority's own key is thrown away once the certificate is signed: an
# authority the iPhone trusts could otherwise vouch for any website, so a copy
# of that key in the wrong hands would be dangerous. It is also limited to this
# Mac's names and the home network's addresses. Running this again (when the
# Mac's name or home address changes, or after 800 days) therefore makes a new
# authority, to install and trust on the iPhone once more.
set -e
dir="$HOME/Library/Application Support/Yonna/phone-tls"
mkdir -p "$dir"
cd "$dir"
host="$(scutil --get LocalHostName).local"
ip="$(ipconfig getifaddr en0 || true)"

if [ ! -f yonna-ca.key ]; then
  openssl req -x509 -newkey rsa:2048 -nodes -days 3650 -sha256 \
    -subj "/CN=Yonna on $(scutil --get ComputerName)" \
    -addext "basicConstraints=critical,CA:TRUE,pathlen:0" -addext "keyUsage=critical,keyCertSign,cRLSign" \
    -addext "nameConstraints=critical,permitted;DNS:$host,permitted;DNS:localhost,permitted;IP:127.0.0.0/255.0.0.0,permitted;IP:192.168.0.0/255.255.0.0,permitted;IP:10.0.0.0/255.0.0.0" \
    -keyout yonna-ca.key -out yonna-ca.crt 2>/dev/null
  chmod 600 yonna-ca.key
fi

san="DNS:$host,DNS:localhost,IP:127.0.0.1"
[ -n "$ip" ] && san="$san,IP:$ip"
cat > server.ext <<EOF
basicConstraints=CA:FALSE
keyUsage=critical,digitalSignature,keyEncipherment
extendedKeyUsage=serverAuth
subjectAltName=$san
EOF
openssl req -newkey rsa:2048 -nodes -subj "/CN=$host" -keyout server.key -out server.csr 2>/dev/null
# iPhones refuse server certificates valid for more than 825 days.
openssl x509 -req -in server.csr -CA yonna-ca.crt -CAkey yonna-ca.key -CAcreateserial \
  -days 800 -sha256 -extfile server.ext -out server.crt 2>/dev/null
chmod 600 server.key
rm -f server.csr server.ext yonna-ca.key yonna-ca.srl
echo "Certificate ready for $host${ip:+ ($ip)}"
