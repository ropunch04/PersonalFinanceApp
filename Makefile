lint:
	ruff check .
	cd frontend && npx eslint src/

format:
	ruff format .
	cd frontend && npx eslint src/ --fix
