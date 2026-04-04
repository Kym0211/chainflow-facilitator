import {
  createKeyPairSignerFromBytes,
  createSolanaRpc,
  devnet,
  createTransactionMessage,
  setTransactionMessageFeePayer,
  setTransactionMessageLifetimeUsingBlockhash,
  appendTransactionMessageInstructions,
  partiallySignTransactionMessageWithSigners,
  getBase64EncodedWireTransaction,
  address,
} from "@solana/kit";
import {
  getSetComputeUnitLimitInstruction,
  getSetComputeUnitPriceInstruction,
} from "@solana-program/compute-budget";
import {
  getTransferCheckedInstruction,
  findAssociatedTokenPda,
  TOKEN_PROGRAM_ADDRESS,
} from "@solana-program/token";
import dotenv from "dotenv";
import { readFileSync } from "fs";

dotenv.config();

const FACILITATOR_URL = "http://localhost:4022";
const NETWORK = "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1";
const USDC_MINT = address("4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU");
const FACILITATOR_ADDRESS = address("G1pPBqcvtQb2X2AbbeHPeeBKFcF7PSQ2ucDEk7Z5CMng");

// Load buyer keypair from file
const buyerKeyBytes = new Uint8Array(JSON.parse(readFileSync("buyer.json", "utf-8")));
const buyer = await createKeyPairSignerFromBytes(buyerKeyBytes);
console.log(`Buyer: ${buyer.address}`);

// Recipient — for testing, we'll just send USDC to the facilitator wallet
const RECIPIENT = FACILITATOR_ADDRESS;
const AMOUNT = 1000n; // 0.001 USDC (6 decimals)

const rpc = createSolanaRpc(devnet(process.env.RPC_URL!));


// Get recent blockhash
const { value: latestBlockhash } = await rpc.getLatestBlockhash().send();
console.log(`Blockhash: ${latestBlockhash.blockhash}`);

// Find the buyer's USDC token account (ATA)
const [buyerATA] = await findAssociatedTokenPda({
  mint: USDC_MINT,
  owner: buyer.address,
  tokenProgram: TOKEN_PROGRAM_ADDRESS,
});
console.log(`Buyer ATA: ${buyerATA}`);

// Find the recipient's USDC token account (ATA)
const [recipientATA] = await findAssociatedTokenPda({
  mint: USDC_MINT,
  owner: RECIPIENT,
  tokenProgram: TOKEN_PROGRAM_ADDRESS,
});
console.log(`Recipient ATA: ${recipientATA}`);

// Build transaction with the 3 required instructions
const message = appendTransactionMessageInstructions(
  [
    // Instruction 1: Compute unit limit
    getSetComputeUnitLimitInstruction({ units: 20_000 }),
    // Instruction 2: Compute unit price
    getSetComputeUnitPriceInstruction({ microLamports: 1n }),
    // Instruction 3: USDC transfer
    getTransferCheckedInstruction({
      source: buyerATA,
      mint: USDC_MINT,
      destination: recipientATA,
      authority: buyer,
      amount: AMOUNT,
      decimals: 6,
    }),
  ],
  setTransactionMessageLifetimeUsingBlockhash(
    latestBlockhash,
    setTransactionMessageFeePayer(
      FACILITATOR_ADDRESS,
      createTransactionMessage({ version: 0 })
    )
  )
);

  // Buyer partially signs (as the transfer authority)
const signedTransaction = await partiallySignTransactionMessageWithSigners(message);

// Encode to base64 for the x402 payload
const base64Transaction = getBase64EncodedWireTransaction(signedTransaction);
console.log(`Transaction encoded, length: ${base64Transaction.length}`);

// Build the x402 payment payload
const paymentPayload = {
  x402Version: 2,
  resource: {
    url: "http://localhost:3000/test",
    description: "Test payment",
    mimeType: "application/json",
  },
  accepted: {
    scheme: "exact",
    network: NETWORK,
    asset: USDC_MINT.toString(),
    amount: AMOUNT.toString(),
    payTo: RECIPIENT.toString(),
    maxTimeoutSeconds: 300,
    extra: { feePayer: FACILITATOR_ADDRESS.toString() },
  },
  payload: {
    transaction: base64Transaction,
  },
};

const paymentRequirements = {
  scheme: "exact",
  network: NETWORK,
  asset: USDC_MINT.toString(),
  amount: AMOUNT.toString(),
  payTo: RECIPIENT.toString(),
  maxTimeoutSeconds: 300,
  extra: { feePayer: FACILITATOR_ADDRESS.toString() },
};

// Step 1: Verify
console.log("\n--- Calling /verify ---");
const verifyRes = await fetch(`${FACILITATOR_URL}/verify`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ paymentPayload, paymentRequirements }),
});
const verifyResult = (await verifyRes.json()) as { isValid: boolean };
console.log("Verify result:", JSON.stringify(verifyResult, null, 2));

if (!verifyResult.isValid) {
  console.error("Verification failed, skipping settle");
  process.exit(1);
}

// Step 2: Settle
console.log("\n--- Calling /settle ---");
const settleRes = await fetch(`${FACILITATOR_URL}/settle`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ paymentPayload, paymentRequirements }),
});
const settleResult = (await settleRes.json()) as { success: boolean; transaction?: string };
console.log("Settle result:", JSON.stringify(settleResult, null, 2));

if (settleResult.success) {
  console.log(`\nTransaction: https://explorer.solana.com/tx/${settleResult.transaction}?cluster=devnet`);
}