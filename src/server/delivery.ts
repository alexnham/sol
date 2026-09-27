import { economyAdapter } from "@solana-workbench/delivery-economy";
import { customAdapter } from "@solana-workbench/delivery-custom";
import { fastAdapter } from "@solana-workbench/delivery-fast";
import { maxAdapter } from "@solana-workbench/delivery-max";
export { quoteRate } from "@solana-workbench/delivery-sdk";
import { registerDeliveryAdapter } from "../shared/plugin-registry";

registerDeliveryAdapter(economyAdapter);
registerDeliveryAdapter(customAdapter);
registerDeliveryAdapter(fastAdapter);
registerDeliveryAdapter(maxAdapter);
