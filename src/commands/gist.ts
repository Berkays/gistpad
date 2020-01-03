import { URL } from "url";
import { commands, env, ExtensionContext, ProgressLocation, QuickPickItem, Uri, window } from "vscode";
import { CommandId, EXTENSION_ID } from "../constants";
import { markGistUpdateAsSeen } from "../gistUpdates";
import { log } from "../logger";
import { GistFile, SortOrder, store } from "../store";
import { changeDescription, deleteGist, forkGist, listGists, newGist, refreshGists, starGist, starredGists, unstarGist } from "../store/actions";
import { ensureAuthenticated, isAuthenticated, signIn } from "../store/auth";
import { refreshTree } from "../tree";
import { FollowedUserGistNode, GistNode, StarredGistNode } from "../tree/nodes";
import { closeGistFiles, getFileContents, getGistDescription, getGistLabel, getGistWorkspaceId, isGistWorkspace, openGist, openGistFiles } from "../utils";
const GIST_URL_PATTERN = /https:\/\/gist\.github\.com\/(?<owner>[^\/]+)\/(?<id>.+)/;

export interface GistQuickPickItem extends QuickPickItem {
  id?: string;
}

const newPublicGist = newGistInternal.bind(null, true);
const newSecretGist = newGistInternal.bind(null, false);

async function newGistInternal(isPublic: boolean = true) {
  await ensureAuthenticated();

  const fileName = await window.showInputBox({
    prompt:
      "Enter the files name(s) to seed the Gist with (can be a comma-seperated list)",
    value: "foo.txt"
  });
  if (!fileName) {
    return;
  }

  const description = await window.showInputBox({
    prompt: "Enter an optional description for the new Gist"
  });

  return window.withProgress(
    { location: ProgressLocation.Notification, title: "Creating Gist..." },
    () => {
      const files = fileName.split(",").map((filename) => ({ filename }));
      return newGist(files, isPublic, description);
    }
  );
}

const SIGN_IN_ITEM = "Sign in to view Gists...";
const CREATE_PUBLIC_GIST_ITEM = "$(gist-new) Create new Gist...";
const CREATE_SECRET_GIST_ITEM = "$(gist-private) Create new secret Gist...";
const STARRED_GIST_ITEM = "$(star) View starred Gists...";
const CREATE_GIST_ITEMS = [
  { label: CREATE_PUBLIC_GIST_ITEM },
  { label: CREATE_SECRET_GIST_ITEM },
  { label: STARRED_GIST_ITEM }
];

interface IOpenGistOptions {
  openAsWorkspace?: boolean;
  node?: GistNode;
  gistUrl?: string;
  gistId?: string;
}

const getGistIdFromUrl = (gistUrl: string) => {
  const url = new URL(gistUrl);
  const { pathname } = url;

  const pathnameComponents = pathname.split("/");
  const id = pathnameComponents[pathnameComponents.length - 1];

  if (!id) {
    log.error(`No gist id found in "${gistUrl}".`);
  }

  return id;
};

async function openGistInternal(
  options: IOpenGistOptions = { openAsWorkspace: false }
) {
  const { node, openAsWorkspace, gistUrl, gistId } = options;

  if (gistUrl || gistId) {
    const id = gistId ? gistId : getGistIdFromUrl(gistUrl!); // (!) since the `gistId` is not set, means the `gistUrl` is set

    return openGist(id, !!openAsWorkspace);
  } else if (node) {
    return openGist(node.gist.id, !!openAsWorkspace);
  }

  let gistItems: GistQuickPickItem[] = [];
  if (await isAuthenticated()) {
    const gists = await listGists();

    if (gists.length > 0) {
      gistItems = gists.map((gist) => {
        return <GistQuickPickItem>{
          label: getGistLabel(gist),
          description: getGistDescription(gist),
          id: gist.id
        };
      });
    }

    gistItems.push(...CREATE_GIST_ITEMS);
  } else {
    gistItems = [{ label: SIGN_IN_ITEM }];
  }

  const list = window.createQuickPick();
  list.placeholder = "Select or specify the Gist you'd like to open";
  list.items = gistItems;

  list.onDidChangeValue((gistId) => {
    list.items = gistId
      ? [{ label: gistId, id: gistId }, ...gistItems]
      : gistItems;
  });

  const clipboardValue = await env.clipboard.readText();
  if (GIST_URL_PATTERN.test(clipboardValue)) {
    list.value = clipboardValue;
    list.items = [{ label: clipboardValue, id: clipboardValue }, ...gistItems];
  }

  list.onDidAccept(async () => {
    const gist = <GistQuickPickItem>list.selectedItems[0] || list.value;

    list.hide();

    if (gist.id) {
      let gistId = gist.id;
      if (GIST_URL_PATTERN.test(gist.id)) {
        gistId = (<any>GIST_URL_PATTERN.exec(gist.id)!).groups.id;
      }

      openGist(gistId, !!openAsWorkspace);
    } else {
      switch (gist.label) {
        case SIGN_IN_ITEM:
          await signIn();
          await openGistInternal();
          return;
        case CREATE_PUBLIC_GIST_ITEM:
          return await newPublicGist();
        case CREATE_SECRET_GIST_ITEM:
          return await newSecretGist();
        case STARRED_GIST_ITEM:
          return await starredGistsInternal();
        default:
      }
    }
  });

  list.show();
}

async function starredGistsInternal() {
  await ensureAuthenticated();

  const gists = await starredGists();
  const items = gists.map((g) => ({
    label: getGistLabel(g),
    description: getGistDescription(g),
    id: g.id
  }));

  if (items.length === 0) {
    const message = `You don't have any starred Gists`;
    return window.showInformationMessage(message);
  }

  const selected = await window.showQuickPick(items, {
    placeHolder: "Select the Gist you'd like to open"
  });

  if (selected) {
    openGistFiles(selected.id);
  }
}

export async function registerGistCommands(context: ExtensionContext) {
  context.subscriptions.push(
    commands.registerCommand(
      `${EXTENSION_ID}.changeGistDescription`,
      async (node?: GistNode) => {
        await ensureAuthenticated();

        if (node) {
          const description = await window.showInputBox({
            prompt: "Specify the description for this Gist",
            value: node.gist.description
          });

          if (!description) {
            return;
          }
          await changeDescription(node.gist.id, description);
        }
      }
    )
  );

  context.subscriptions.push(
    commands.registerCommand(
      `${EXTENSION_ID}.cloneRepository`,
      async (node: GistNode) => {
        commands.executeCommand("git.clone", node.gist.git_pull_url);
      }
    )
  );

  context.subscriptions.push(
    commands.registerCommand(
      `${EXTENSION_ID}.copyGistUrl`,
      async (node: GistNode) => {
        // Note: The "html_url" property doesn't include the Gist's owner
        // in it, and the API doesn't support that URL format
        const url = `https://gist.github.com/${node.gist.owner!.login}/${
          node.gist.id
          }`;
        env.clipboard.writeText(url);
      }
    )
  );

  const DELETE_RESPONSE = "Delete";
  context.subscriptions.push(
    commands.registerCommand(
      `${EXTENSION_ID}.deleteGist`,
      async (targetNode?: GistNode, multiSelectNodes?: GistNode[]) => {
        await ensureAuthenticated();

        if (targetNode) {
          const suffix = multiSelectNodes
            ? "selected gists"
            : `"${targetNode.label}" gist`;

          const response = await window.showInformationMessage(
            `Are you sure you want to delete the ${suffix}?`,
            DELETE_RESPONSE
          );
          if (response !== DELETE_RESPONSE) {
            return;
          }

          const nodes = multiSelectNodes || [targetNode];
          for (const node of nodes) {
            await deleteGist(node.gist.id);
            await closeGistFiles(node.gist);
          }
        } else if (isGistWorkspace()) {
          const response = await window.showInformationMessage(
            "Are you sure you want to delete the opened Gist?",
            DELETE_RESPONSE
          );
          if (response !== DELETE_RESPONSE) {
            return;
          }

          const gistId = getGistWorkspaceId();
          deleteGist(gistId);
          commands.executeCommand("workbench.action.closeFolder");
        } else {
          const gists = await listGists();

          if (gists.length === 0) {
            return window.showInformationMessage(
              "You don't have any Gists to delete"
            );
          }

          const items = gists.map((g) => ({
            label: getGistLabel(g),
            description: getGistDescription(g),
            id: g.id
          }));

          const gist = await window.showQuickPick(items, {
            placeHolder: "Select the Gist to delete..."
          });
          if (!gist) {
            return;
          }

          await deleteGist(gist.id);
          await closeGistFiles(gists.find((gist) => gist.id === gist.id)!);
          await window.showInformationMessage("Gist deleted!");
        }
      }
    )
  );

  context.subscriptions.push(
    commands.registerCommand(
      `${EXTENSION_ID}.forkGist`,
      async (node?: StarredGistNode | FollowedUserGistNode) => {
        await ensureAuthenticated();

        let gistId: string | undefined;
        if (node) {
          gistId = node.gist.id;
        } else if (isGistWorkspace()) {
          gistId = getGistWorkspaceId();
        } else {
          // TODO: Display the list of starred gists
          gistId = await window.showInputBox({
            prompt: "Enter the Gist ID to fork"
          });
          if (!gistId) {
            return;
          }
        }

        await window.withProgress(
          { location: ProgressLocation.Notification, title: "Forking Gist..." },
          () => forkGist(gistId!)
        );
      }
    )
  );

  context.subscriptions.push(
    commands.registerCommand(
      `${EXTENSION_ID}.markGistAsRead`,
      async (node?: StarredGistNode | FollowedUserGistNode) => {
        if (!node) {
          log.error(`"markGistAsRead" invoked but no node passed.`);
          return;
        }

        markGistUpdateAsSeen(node.section, node.gist);

        refreshTree();
      }
    )
  );

  context.subscriptions.push(
    commands.registerCommand(`${EXTENSION_ID}.newPublicGist`, newPublicGist)
  );

  context.subscriptions.push(
    commands.registerCommand(`${EXTENSION_ID}.newSecretGist`, newSecretGist)
  );

  context.subscriptions.push(
    commands.registerCommand(CommandId.openGist, (node?: GistNode) => {
      openGistInternal({ node });
    })
  );

  context.subscriptions.push(
    commands.registerCommand(
      `${EXTENSION_ID}.openGistInBrowser`,
      async (node: GistNode) => {
        env.openExternal(Uri.parse(node.gist.html_url));
      }
    )
  );

  context.subscriptions.push(
    commands.registerCommand(
      `${EXTENSION_ID}.openGistInNbViewer`,
      async (node: GistNode) => {
        const url = `https://nbviewer.jupyter.org/gist/${node.gist.owner.login}/${node.gist.id}`;
        env.openExternal(Uri.parse(url));
      }
    )
  );

  context.subscriptions.push(
    commands.registerCommand(
      `${EXTENSION_ID}.openGistWorkspace`,
      (node?: GistNode) => {
        openGistInternal({ node, openAsWorkspace: true });
      }
    )
  );

  context.subscriptions.push(
    commands.registerCommand(`${EXTENSION_ID}.refreshGists`, refreshGists)
  );

  context.subscriptions.push(
    commands.registerCommand(`${EXTENSION_ID}.sortGistsAlphabetically`, () => {
      store.sortOrder = SortOrder.alphabetical;
    })
  );

  context.subscriptions.push(
    commands.registerCommand(`${EXTENSION_ID}.sortGistsByUpdatedTime`, () => {
      store.sortOrder = SortOrder.updatedTime;
    })
  );

  context.subscriptions.push(
    commands.registerCommand(
      `${EXTENSION_ID}.starredGists`,
      starredGistsInternal
    )
  );

  context.subscriptions.push(
    commands.registerCommand(
      `${EXTENSION_ID}.unstarGist`,
      async (
        targetNode: StarredGistNode,
        multiSelectNodes?: StarredGistNode[]
      ) => {
        await ensureAuthenticated();

        const nodes = multiSelectNodes || [targetNode];
        for (const node of nodes) {
          unstarGist(node.gist.id);
        }
      }
    )
  );

  context.subscriptions.push(
    commands.registerCommand(
      `${EXTENSION_ID}.starGist`,
      async (
        targetNode: GistNode | FollowedUserGistNode,
        multiSelectNodes?: GistNode[] | FollowedUserGistNode[]
      ) => {
        await ensureAuthenticated();

        const nodes = multiSelectNodes || [targetNode];
        for (const node of nodes) {
          starGist(node.gist);
        }
      }
    )
  );

  context.subscriptions.push(
    commands.registerCommand(
      `${EXTENSION_ID}.duplicateGist`,
      async (node: GistNode) => {
        await ensureAuthenticated();

        const description = await window.showInputBox({
          prompt: "Enter an optional description for the new Gist",
          value: node.gist.description
        });

        await window.withProgress(
          {
            location: ProgressLocation.Notification,
            title: "Duplicating Gist..."
          },
          async () => {
            const files: GistFile[] = [];
            for (const filename of Object.keys(node.gist.files)) {
              const content = await getFileContents(node.gist.files[filename]);
              files.push({
                filename,
                content
              });
            }

            newGist(files, node.gist.public, description);
          }
        );
      }
    )
  );
}
