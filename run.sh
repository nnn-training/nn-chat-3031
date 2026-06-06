yarn install
npx prisma db push --yes
npx prisma generate
node index.js