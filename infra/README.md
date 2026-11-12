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

Let's Encrypt limits repeated requests for one domain. To test, set `certbot_staging: true` in `group_vars/all/local.yml` and run the certbot tag. Browsers do not trust staging certificates. If a certificate already exists, the certificate request is skipped. A staging certificate stays in place until you replace it.

To switch to a real certificate, turn staging off and set `certbot_force`:

```bash
ansible-playbook site.yml --tags certbot -e certbot_staging=false -e certbot_force=true
```

With `certbot_force=true` and `certbot_staging=false`, the certbot role checks the certificate on the server. If it came from the staging server, the role does four steps. It deletes the certificate. It writes an HTTP-only Nginx file. It requests the real certificate. It adds the HTTPS block again. A real certificate is never deleted by this variable, so a second run with the same command changes nothing.

To delete a certificate by hand, run this on the server:

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

## Override variables

A variable is a named setting, such as `domain` or `certbot_staging`. The defaults are in `group_vars/all/defaults.yml`. You can change a value in four ways. The list goes from the weakest way to the strongest way. A stronger way wins over a weaker way.

1. `group_vars/all/defaults.yml`: shared defaults for everyone. This file is public. If a new value is right for every user of the repo, change it here and commit it.
2. `group_vars/all/local.yml`: your own values. The file is in `.gitignore`, so it stays on your Mac. This is the right place for your domain, email, and IP.
3. `host_vars/<host>.yml`: values for one server only, for example `host_vars/reddit.yml`. If you add a second server with different settings, put its values here. Create the folder yourself.
4. `-e` on the command line: a value for one run only. It beats every file, and it does not change any file.

Ansible loads the files in `group_vars/all/` in alphabetical order. A file that loads later wins. `defaults.yml` comes before `local.yml`, so `local.yml` wins. If you add a file to that folder, choose a name that sorts in the right place.

To change a value for one run, add `-e`:

```bash
ansible-playbook site.yml --tags certbot -e certbot_staging=false
```

To set several values, repeat `-e`:

```bash
ansible-playbook site.yml -e domain=example.org -e admin_email=me@example.org
```

To set a list or a file of values, use JSON or `@file`:

```bash
ansible-playbook site.yml -e '{"site_domains": ["example.org", "www.example.org"]}'
ansible-playbook site.yml -e @my-values.yml
```

To see the final value of each variable for a server, before a run:

```bash
ansible-inventory --host reddit
```

This command shows the merged values from all files. It does not show values from `-e`.

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
