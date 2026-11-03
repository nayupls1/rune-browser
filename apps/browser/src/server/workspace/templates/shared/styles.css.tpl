@import "./tokens.css";

*,
*::before,
*::after {
  box-sizing: border-box;
}

body {
  margin: 0;
  background: var(--color-bg);
  color: var(--color-text);
  font-family: var(--font-sans);
  font-size: 15px;
  line-height: 1.5;
}

h1 {
  margin: 0 0 var(--space-2);
  font-size: 28px;
  letter-spacing: -0.02em;
}

.page {
  max-width: 640px;
  margin: 0 auto;
  padding: var(--space-6) var(--space-4);
}

.muted {
  color: var(--color-muted);
}

.row {
  display: flex;
  gap: var(--space-2);
  margin: var(--space-5) 0 var(--space-4);
}

input {
  flex: 1;
  padding: var(--space-2) var(--space-3);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-md);
  background: var(--color-surface);
  color: inherit;
  font: inherit;
}

input:focus {
  outline: 2px solid var(--color-accent);
  outline-offset: -1px;
}

button {
  padding: var(--space-2) var(--space-4);
  border: none;
  border-radius: var(--radius-md);
  background: var(--color-accent);
  color: var(--color-accent-text);
  font: inherit;
  font-weight: 600;
  cursor: pointer;
}

button.ghost {
  background: transparent;
  color: var(--color-muted);
  font-weight: 500;
}

button.ghost:hover {
  background: var(--color-surface-hover);
  color: var(--color-text);
}

.list {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
  margin: 0;
  padding: 0;
  list-style: none;
}

.card {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-3);
  padding: var(--space-3) var(--space-4);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-lg);
  background: var(--color-surface);
  box-shadow: var(--shadow-sm);
}
