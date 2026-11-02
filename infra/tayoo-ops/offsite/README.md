# Copie hors serveur des sauvegardes (Cloudflare R2)

Installé le 2026-11-02. Outil : `offsite-backup.sh` (`run | status | enable SLUG | disable SLUG | list SLUG | restore-test [SLUG]`).

- Chaque nuit (timer `tayoo-offsite-backup`, 04:30 UTC, après `supabase-backup` de 03:30) : chaque
  sauvegarde locale pas encore copiée des instances listées dans `enabled` est empaquetée, chiffrée avec
  la clé de l'instance (`keys/<slug>.key`, age) puis envoyée dans `tayoo-backups/<slug>/<dossier>.tar.age`.
  Taille vérifiée côté R2 après envoi. Échec ou sauvegarde locale de plus de 36 h → courriel.
- Le 1er de chaque mois (timer `tayoo-offsite-restore-test`) : dernière copie de chaque instance
  téléchargée, déchiffrée, MANIFEST.sha256 vérifié, db.dump lu par pg_restore → courriel de synthèse.
- Seau : verrou de 30 jours (rien ne s'efface ni ne s'écrase avant) + suppression à 35 jours.
- Identifiants : `r2.env` (600) — jeton R2 « Object Read & Write » limité au seau `tayoo-backups`.

## LES CLÉS — sans elles les copies sont illisibles
`keys/*.key` doivent AUSSI exister hors du serveur (gestionnaire de mots de passe). Si le VPS disparaît,
seules ces clés permettent de relire les copies.

## Restaurer depuis R2 si le VPS est perdu
1. Nouveau jeton R2 (lecture) ; `rclone copyto r2:tayoo-backups/<slug>/<dossier>.tar.age ./x.tar.age`
   (endpoint `https://b3db6259fa4bcfd65fa7c16d348ffcb3.r2.cloudflarestorage.com`).
2. `age -d -i <slug>.key x.tar.age | tar -x` → dossier de sauvegarde habituel (db.dump, globals.sql,
   files.tar.gz, env, MANIFEST.sha256) ; `sha256sum -c MANIFEST.sha256`.
3. Restaurer comme une sauvegarde locale (`/srv/supabase/bin/` : `restore-cloud.sh`, `verify-backup.sh`,
   cf. `dr-rehearsal.sh`) sur une instance recréée.

### `/etc/systemd/system/tayoo-offsite-backup.service`

```ini
# Tayoo Ops — copie chiffrée des sauvegardes vers Cloudflare R2 (/srv/supabase/offsite).
[Unit]
Description=Tayoo Ops — copie hors serveur des sauvegardes (Cloudflare R2)
After=docker.service network-online.target supabase-backup.service
Wants=network-online.target
Requires=docker.service

[Service]
Type=oneshot
ExecStart=/srv/supabase/offsite/offsite-backup.sh run
TimeoutStartSec=2h
Nice=10
IOSchedulingClass=idle
```

### `/etc/systemd/system/tayoo-offsite-backup.timer`

```ini
[Unit]
Description=Tayoo Ops — copie hors serveur chaque nuit après la sauvegarde de 03:30 UTC

[Timer]
OnCalendar=*-*-* 04:30:00 UTC
RandomizedDelaySec=10min
Persistent=true

[Install]
WantedBy=timers.target
```

### `/etc/systemd/system/tayoo-offsite-restore-test.service`

```ini
[Unit]
Description=Tayoo Ops — test mensuel de restauration des copies R2
After=docker.service network-online.target
Wants=network-online.target
Requires=docker.service

[Service]
Type=oneshot
ExecStart=/srv/supabase/offsite/offsite-backup.sh restore-test
TimeoutStartSec=1h
Nice=10
```

### `/etc/systemd/system/tayoo-offsite-restore-test.timer`

```ini
[Unit]
Description=Tayoo Ops — test de restauration le 1er de chaque mois

[Timer]
OnCalendar=*-*-01 05:15:00 UTC
Persistent=true

[Install]
WantedBy=timers.target
```
