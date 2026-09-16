import 'dotenv/config';
const port=Number(process.env.TEST_DATABASE_PORT || 25434);
process.env.TEST_DATABASE_URL=`postgres://${encodeURIComponent(process.env.POSTGRES_USER)}:${encodeURIComponent(process.env.POSTGRES_PASSWORD)}@127.0.0.1:${port}/catetindulu_shared_test`;
await import('../test/database.mjs');
await import('../test/shared-database.mjs');
