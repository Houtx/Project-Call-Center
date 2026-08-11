.PHONY: install db-up db-down db-reset migrate seed dev-api dev-web test build android-test android-apk

install:
	npm install

db-up:
	docker compose up -d postgres

db-down:
	docker compose down

db-reset:
	docker compose down -v
	docker compose up -d postgres

migrate:
	npm run db:generate
	npm run db:migrate

seed:
	npm run db:seed

dev-api:
	npm run dev:api

dev-web:
	npm run dev:web

test:
	npm test

build:
	npm run build

android-test:
	cd apps/android && ./gradlew test

android-apk:
	cd apps/android && ./gradlew assembleDebug
