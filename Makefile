.PHONY: up down migrate seed test typecheck logs psql reset

up:            ## start postgres, redis, api, worker and console
	docker compose up -d --build
	@echo "console → http://localhost:3000   api → http://localhost:8080/healthz"

down:
	docker compose down

reset:         ## wipe the local database and start again
	docker compose down -v && docker compose up -d postgres redis

migrate:
	npm run migrate

seed:          ## migrate, then create a demo workspace with one conversation
	npm run seed

test:          ## full suite: runs Postgres in-process, no docker needed
	npm test

typecheck:
	npm run typecheck

logs:
	docker compose logs -f api worker console

demo:          ## API on in-memory Postgres + console, no docker needed
	@echo "run these in two terminals:"
	@echo "  npm run dev:stack"
	@echo "  npm run dev:console" 

psql:
	docker compose exec postgres psql -U kirana_owner -d kirana
