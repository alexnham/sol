import { render, screen } from "@testing-library/react";
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
});
