import React from "react";
import { createRoot } from "react-dom/client";
import "../styles.css";
import "./review.css";
import { WriteReview } from "./Review";

const root = document.getElementById("root");
if (!root) throw new Error("Review root is missing");
createRoot(root).render(
  <React.StrictMode>
    <WriteReview />
  </React.StrictMode>,
);
