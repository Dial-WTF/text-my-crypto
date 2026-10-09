# Dial's Zcash testnet wallet service. Cloudflare Containers run linux/amd64: build with
# `docker build --platform linux/amd64 .` (wrangler does this itself).
FROM rust:1.98.1-bookworm AS build
WORKDIR /src
COPY Cargo.toml Cargo.lock ./
COPY src ./src
RUN cargo build --release --locked

FROM debian:bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates && rm -rf /var/lib/apt/lists/* \
  && useradd --system --uid 10001 --no-create-home dial && mkdir /data && chown dial /data
COPY --from=build /src/target/release/zcash-wallet /usr/local/bin/zcash-wallet
USER dial
ENV DATA_DIR=/data PORT=8080
VOLUME /data
EXPOSE 8080
CMD ["zcash-wallet"]
