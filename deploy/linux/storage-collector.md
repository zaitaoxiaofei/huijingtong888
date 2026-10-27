# Storage usage collector

The application reads `/run/ozon-erp-monitor/storage-usage.json`. The root collector only measures fixed directories and binlog file sizes. It never loads application code, database credentials, arguments, or an application environment file.

Install the reviewed files as root-owned files, before enabling collection or asking the application to capture a monitoring snapshot. From a trusted release directory:

```sh
install -d -o root -g root -m 0755 /usr/local/libexec
install -o root -g root -m 0755 deploy/linux/collect-storage-usage.py /usr/local/libexec/ozon-erp-storage-collector.py
install -o root -g root -m 0644 deploy/linux/ozon-erp-storage-collector.service /etc/systemd/system/ozon-erp-storage-collector.service
install -o root -g root -m 0644 deploy/linux/ozon-erp-storage-collector.timer /etc/systemd/system/ozon-erp-storage-collector.timer
systemctl daemon-reload
systemctl start ozon-erp-storage-collector.service
systemctl enable --now ozon-erp-storage-collector.timer
stat -c '%U:%G %a %n' /usr/local/libexec/ozon-erp-storage-collector.py /run/ozon-erp-monitor /run/ozon-erp-monitor/storage-usage.json
```

Expected ownership is `root:root`; script and runtime directory mode is `0755`, units and JSON mode is `0644`. The application must not be able to write the script, runtime directory, snapshot, or their parent installation directories. The service invokes the installed Python script in isolated mode, without a release-directory working directory or application imports. Its only writable path is the dedicated runtime directory, and its capability set contains only `CAP_DAC_READ_SEARCH`.

The timer refreshes the file every five minutes. Application reads reject stale snapshots after fifteen minutes, future timestamps, untrusted permissions, symlinks and invalid measurements. A failed measurement is represented by `null` and an error code; an empty successfully measured directory remains `0`. If the root snapshot cannot be used, the application tries direct reads and records any failed metrics as unknown. `details_json.storageCollection` records the source, collection time and error codes; API fields for failed metrics are `null` and the monitoring job reports `partial`.

The existing monitoring database schema remains unchanged: its non-null numeric columns contain compatibility placeholders for failed metrics, so queries must inspect `details_json.storageCollection.errors` before interpreting zeros. No application restart is required to install or refresh the root collector itself.

Inspect `systemctl status ozon-erp-storage-collector.timer` and `journalctl -u ozon-erp-storage-collector.service` for collector failures. A missing fixed directory is reported as unknown instead of silently being counted as an empty directory.
