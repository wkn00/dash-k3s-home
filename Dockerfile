# Go is not installed on the laptops; it lives here instead.
FROM golang:1.25-alpine AS build
WORKDIR /src
# No dependencies by design — go.mod has no require block, so there is
# nothing to download and the build works offline.
COPY go.mod ./
COPY cmd/ ./cmd/
COPY internal/ ./internal/
RUN CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o /out/k3s-dash ./cmd/k3s-dash

FROM gcr.io/distroless/static:nonroot
COPY --from=build /out/k3s-dash /k3s-dash
USER 65532:65532
ENTRYPOINT ["/k3s-dash"]
