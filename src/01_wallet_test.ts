import 'dotenv/config';
import { Wallet, JsonRpcProvider } from 'ethers';

async function main() {
  const provider = new JsonRpcProvider(process.env.RPC_URL);
  const wallet = new Wallet(process.env.WALLET_PRIVATE_KEY!, provider);

  console.log('wallet address:', wallet.address);
}

main();
