import 'dotenv/config';
process.env.TEST_DATABASE_URL=`postgres://${process.env.POSTGRES_USER}:${process.env.POSTGRES_PASSWORD}@127.0.0.1:25432/catetindulu_test`;
await import('../test/database.mjs');
