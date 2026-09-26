import { economyAdapter } from "@solana-workbench/delivery-economy";
import { fastAdapter } from "@solana-workbench/delivery-fast";
import { maxAdapter } from "@solana-workbench/delivery-max";
export { quoteRate } from "@solana-workbench/delivery-sdk";
import { registerDeliveryAdapter } from "../shared/plugin-registry";

registerDeliveryAdapter(economyAdapter);
registerDeliveryAdapter(fastAdapter);
registerDeliveryAdapter(maxAdapter);
