FROM node@sha256:83f487e0a63425e5b4d146fb5e5be574bcbe1b7b843d3ebafdd95eaf7767a7e5
# Test-only tools. This image is never published or used for production delivery.
RUN apt-get update && apt-get install -y --no-install-recommends openssh-server python3 \
    && rm -rf /var/lib/apt/lists/* /etc/ssh/ssh_host_* \
    && useradd --uid 41111 --home-dir /var/empty/lk-frontend --shell /bin/sh --password '*' lk-frontend \
    && mkdir -p /var/empty/lk-frontend /usr/local/libexec/lk-frontend /etc/ssh/authorized_keys \
    && chmod 755 /var/empty/lk-frontend /etc/ssh/authorized_keys
COPY frontend-release-remote.py /usr/local/libexec/lk-frontend/frontend-release-remote.py
RUN chmod 555 /usr/local/libexec/lk-frontend && chmod 444 /usr/local/libexec/lk-frontend/frontend-release-remote.py
