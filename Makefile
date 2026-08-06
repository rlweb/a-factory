.PHONY: verify vet lint test build smoke clean

verify: vet lint test          ## the release gate — must pass before any PR (this repo eats its own dogfood)

vet:
	go build ./...
	go vet ./...

lint:
	golangci-lint run

test:
	go test ./... -race -cover

build:
	go build -o dist/a-factory ./cmd/a-factory

smoke:                          ## NOT part of verify — requires real EXE_API_TOKEN + GitHub credentials
	FACTORY_SMOKE=1 go run ./cmd/smoke

clean:
	rm -rf dist/
