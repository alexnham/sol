import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import App from "../client/App";

describe("workbench UI", () => {
  it("shows one transaction and disables Sender routes on devnet", () => {
    render(<App />);
    expect(document.querySelector(".one-tx")).toHaveTextContent("1 transaction");
    expect(screen.getByRole("button", { name: "Fast delivery route" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Sender Max delivery route" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Prepare live quote" })).toBeEnabled();
  });

  it("opens the Keygen wallet manager without exposing secret inputs", () => {
    render(<App />);
    fireEvent.click(screen.getByRole("button", { name: /Keygen/ }));
    expect(screen.getByRole("heading", { name: "Managed wallets" })).toBeInTheDocument();
    expect(screen.getByLabelText("New keypairs")).toHaveValue(1);
    expect(screen.queryByLabelText(/private|secret/i)).not.toBeInTheDocument();
  });
});
