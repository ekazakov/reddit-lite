// Creates the test database if it does not exist. The tests themselves reset the schema and run migrations.
// Usage: pnpm db:test:setup. Set TEST_DATABASE_URL to use another server or name.
import postgres from 'postgres';

const url = new URL(
  process.env.TEST_DATABASE_URL ?? 'postgres://postgres:postgres@localhost:5432/reddit_lite_test',
);
const name = decodeURIComponent(url.pathname.slice(1));

// The same rule as the guard in test/app.test.ts. Refuse names that could belong to real data.
if (!/^[a-z0-9_]+_test$/.test(name)) {
  console.error(`Refusing to create "${name}": the test database name must end with _test.`);
  process.exit(1);
}

// CREATE DATABASE cannot run inside the target database, so connect to the default "postgres" database.
url.pathname = '/postgres';
const sql = postgres(url.toString(), { onnotice: () => {}, max: 1 });

try {
  const rows = await sql`SELECT 1 FROM pg_database WHERE datname = ${name}`;
  if (rows.length > 0) {
    console.log(`Database ${name} already exists.`);
  } else {
    // A database name cannot be a query parameter. The regex above allows only safe characters.
    await sql.unsafe(`CREATE DATABASE ${name}`);
    console.log(`Created database ${name}.`);
  }
} finally {
  await sql.end();
}
