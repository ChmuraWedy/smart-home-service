FROM golang:1.26.2-bookworm AS build
WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download
COPY main.go main_test.go ./
RUN go test ./... && CGO_ENABLED=0 go build -trimpath -o /camera-lan-probe .

FROM scratch
COPY --from=build /camera-lan-probe /camera-lan-probe
USER 1000:1000
ENTRYPOINT ["/camera-lan-probe"]
