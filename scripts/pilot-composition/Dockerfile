FROM nodered/node-red:4.0.9-22
USER root
RUN mkdir -p /data/node_modules/padlhub-residency-lifecycle-api
COPY residency-lifecycle-api/ /data/node_modules/padlhub-residency-lifecycle-api/
RUN cd /data/node_modules/padlhub-residency-lifecycle-api && npm install --omit=dev --no-audit --no-fund
COPY flows.json /data/flows.json
COPY settings.js /data/settings.js
RUN chown -R node-red:node-red /data
USER node-red