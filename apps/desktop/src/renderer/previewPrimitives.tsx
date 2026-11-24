import * as stylex from "@stylexjs/stylex";
import { InboxIcon, PencilIcon, Trash2Icon } from "lucide-react";
import { useState, type ReactNode } from "react";

import { Badge } from "./Badge.tsx";
import { Button } from "./Button.tsx";
import { Card } from "./Card.tsx";
import { EmptyState } from "./EmptyState.tsx";
import { Input, SearchField } from "./Input.tsx";
import { Keycap } from "./Keycap.tsx";
import { ListRow } from "./ListRow.tsx";
import { Menu, MenuGroupLabel, MenuItem, MenuPopup, MenuSeparator, MenuTrigger } from "./Menu.tsx";
import { Popover, PopoverPopup, PopoverTrigger } from "./Popover.tsx";
import { ScrollArea } from "./ScrollArea.tsx";
import { ProgressBar, Skeleton } from "./Skeleton.tsx";
import { Switch } from "./Switch.tsx";
import { ToggleGroup } from "./ToggleGroup.tsx";
import { color, font, space, text } from "./tokens.stylex.ts";

// Preview scenes for the shared primitives, one per ?ui= name. Every value is synthetic.
const styles = stylex.create({
  page: {
    display: "flex",
    flexDirection: "column",
    gap: space.base,
    minHeight: "100vh",
    padding: space.xl,
    backgroundColor: color.background,
    color: color.foreground,
    fontFamily: font.sans,
    fontSize: text.sm,
    WebkitFontSmoothing: "antialiased",
  },
  row: { display: "flex", flexWrap: "wrap", alignItems: "center", gap: space.sm },
  column: { display: "flex", flexDirection: "column", gap: space.sm, maxWidth: 360 },
  scroller: { height: 160, maxWidth: 360 },
  lines: { margin: 0, padding: space.md },
});

function Toggles() {
  const [tab, setTab] = useState<"personal" | "work" | "email">("personal");
  const [on, setOn] = useState(true);
  return (
    <>
      <ToggleGroup
        label="Message type"
        value={tab}
        onChange={setTab}
        options={[
          { value: "personal", label: "Personal messages" },
          { value: "work", label: "Work messages" },
          { value: "email", label: "Email" },
        ]}
      />
      <div {...stylex.props(styles.row)}>
        <Switch id="preview-switch" checked={on} onChange={setOn} />
        <Switch id="preview-switch-off" checked={false} onChange={() => {}} />
        <Switch id="preview-switch-disabled" checked disabled onChange={() => {}} />
      </div>
    </>
  );
}

export const uiScenes: Record<string, () => ReactNode> = {
  buttons: () => (
    <div {...stylex.props(styles.row)}>
      <Button>Save changes</Button>
      <Button variant="secondary">Cancel</Button>
      <Button variant="destructive">Delete</Button>
      <Button disabled>Disabled</Button>
      <Button variant="text">Show more</Button>
      <Button variant="icon" aria-label="Edit">
        <PencilIcon size={16} />
      </Button>
      <Badge>Beta</Badge>
      <Keycap>⌥</Keycap>
      <Keycap>Space</Keycap>
    </div>
  ),
  input: () => (
    <div {...stylex.props(styles.column)}>
      <Input aria-label="Trigger" placeholder="my email" />
      <Input aria-label="Trigger with a problem" defaultValue="btw" invalid />
      <Input aria-label="Disabled" placeholder="Disabled" disabled />
      <SearchField aria-label="Search history" placeholder="Search" />
    </div>
  ),
  menu: () => (
    <Menu defaultOpen>
      <MenuTrigger render={<Button variant="secondary" />}>Account</MenuTrigger>
      <MenuPopup>
        <MenuGroupLabel>ada@example.com</MenuGroupLabel>
        <MenuItem icon={<PencilIcon size={16} />}>Edit profile</MenuItem>
        <MenuItem disabled>Upgrade</MenuItem>
        <MenuSeparator />
        <MenuItem icon={<Trash2Icon size={16} />} destructive>
          Sign out
        </MenuItem>
      </MenuPopup>
    </Menu>
  ),
  popover: () => (
    <Popover defaultOpen>
      <PopoverTrigger render={<Button variant="secondary" />}>What's new</PopoverTrigger>
      <PopoverPopup title="Version 1.5.0" align="start">
        Meetings now keep a summary next to the transcript.
      </PopoverPopup>
    </Popover>
  ),
  toggles: () => <Toggles />,
  "list-row": () => (
    <Card>
      <ListRow
        title="my email"
        detail="ada@example.com"
        trailing={
          <Button variant="icon" aria-label="Edit my email">
            <PencilIcon size={16} />
          </Button>
        }
      />
      <ListRow title="office address" detail="Analytical Engines Ltd., 12 Marylebone Road" />
    </Card>
  ),
  empty: () => (
    <Card>
      <EmptyState
        icon={<InboxIcon size={18} />}
        title="No snippets yet"
        description="Say a short phrase and Voice types the saved text."
      >
        <Button>Add new</Button>
      </EmptyState>
    </Card>
  ),
  skeleton: () => (
    <div {...stylex.props(styles.column)}>
      <Skeleton width="60%" />
      <Skeleton />
      <Skeleton shape="card" height="64px" />
      <Skeleton shape="pill" width="96px" height="20px" />
      <ProgressBar label="Model download" value={42} />
    </div>
  ),
  "scroll-area": () => (
    <Card style={styles.scroller}>
      <ScrollArea fade>
        <ol {...stylex.props(styles.lines)}>
          {Array.from({ length: 24 }, (_, index) => (
            <li key={index}>Transcript line {index + 1}</li>
          ))}
        </ol>
      </ScrollArea>
    </Card>
  ),
};

export function PrimitivePreview({ scene }: { scene: string }) {
  const names = scene === "all" ? Object.keys(uiScenes) : [scene];
  return (
    <main {...stylex.props(styles.page)}>
      {names.map((name) => (
        <section key={name} {...stylex.props(styles.column)} aria-label={name}>
          {uiScenes[name]?.()}
        </section>
      ))}
    </main>
  );
}
