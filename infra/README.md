# Server setup with Ansible

This folder installs Nginx with a free Let's Encrypt certificate on a Kamatera Ubuntu server. You run Ansible from your Mac. The server must already exist.

## Before you start

1. Create an Ubuntu 24.04 server in the Kamatera console with your SSH public key.
2. Add a DNS A record for your domain that points to the server IP. Make sure that `dig +short <domain>` prints the server IP. With Cloudflare, turn the proxy off until the certificate exists.
3. Install the tools: `brew install ansible`.
4. Install the collections: `ansible-galaxy collection install -r requirements.yml -p ~/.ansible/collections`.
5. Copy `group_vars/all/local.yml.example` to `group_vars/all/local.yml` and fill in `domain`, `admin_email`, `server_ip`, and `deploy_user_public_key_file`. The file is in `.gitignore`, so your private values stay out of the public repo. Ansible loads `local.yml` after `group_vars/all/defaults.yml`, so a value in `local.yml` wins. If a value is still a placeholder, the playbook stops and prints a message.
6. Copy `inventory.ini.example` to `inventory.ini` and edit it. The default uses the `reddit` host from `~/.ssh/config`.

## Run

Keep the Kamatera web console open during the first run. If the firewall blocks SSH, the console gives you terminal access.

Make sure that the connection works:

```bash
cd infra
ansible web -m ping
```

Do a dry run:

```bash
ansible-playbook site.yml --check --diff --tags base,firewall,nginx
```

Configure the server. This step does not need DNS:

```bash
ansible-playbook site.yml --tags base,firewall,nginx
```

When DNS points to the server, get the certificate:

```bash
ansible-playbook site.yml --tags certbot
```

Run the full playbook once more. The summary must show `changed=0`:

```bash
ansible-playbook site.yml
```

## Test the certificate first (optional)

Let's Encrypt limits repeated requests for one domain. To test, set `certbot_staging: true` in `group_vars/all/local.yml` and run the certbot tag. Browsers do not trust staging certificates. To switch to a real certificate, delete the staging one on the server, then set `certbot_staging: false` and run again:

```bash
ssh reddit sudo certbot delete --cert-name <domain>
```

## Verify

```bash
curl -I https://<domain>
curl -I http://<domain>
ssh reddit sudo certbot renew --dry-run
ssh reddit sudo ufw status
```

The first command returns HTTP 200. The second returns a 301 redirect to HTTPS.

## Check the playbook before a run

Run these checks on your Mac. They do not connect to the server.

If `ansible-lint` is not installed, install it:

```bash
brew install ansible-lint
```

Make sure that the collections are installed. The linter needs them to know the modules:

```bash
cd infra
ansible-galaxy collection install -r requirements.yml -p ~/.ansible/collections
```

The path is required because `ansible-lint` can use a different Python environment than `ansible-playbook`. It finds collections only in `~/.ansible/collections`.

Check the syntax of the playbook:

```bash
ansible-playbook site.yml --syntax-check
```

Run the linter. It reports style problems and risky patterns:

```bash
ansible-lint site.yml
```

If the linter prints `couldn't resolve module/action`, a collection is missing. Run the `ansible-galaxy` command again.

## Roles

| Role | What it does |
| --- | --- |
| `base` | Updates packages, turns on automatic security updates, creates the sudo user with your SSH key. |
| `firewall` | Allows ports 22, 80, and 443 and blocks the rest. The SSH rule is added before the firewall turns on. |
| `nginx` | Installs Nginx, writes the virtual host, and serves a placeholder page. |
| `certbot` | Checks DNS, gets the certificate with the webroot method, adds the HTTPS block, and enables renewal. |

## Future tasks

- SSH hardening: set `PermitRootLogin no` and `PasswordAuthentication no`. Do this only after you log in as the sudo user with the key. Change `ansible_user` in `inventory.ini` first.
- App deploy: a role that runs the reddit-lite app and an Nginx `proxy_pass` block.
