/*
Copyright 2022 The Matrix.org Foundation C.I.C.

Licensed under the Apache License, Version 2.0 (the "License");
you may not use this file except in compliance with the License.
You may obtain a copy of the License at

    http://www.apache.org/licenses/LICENSE-2.0

Unless required by applicable law or agreed to in writing, software
distributed under the License is distributed on an "AS IS" BASIS,
WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
See the License for the specific language governing permissions and
limitations under the License.
*/

import React from "react";
import { zip } from "lodash";
import { render, screen, act, fireEvent, waitFor, cleanup } from "@testing-library/react";
import { mocked, Mocked } from "jest-mock";
import { MatrixClient, PendingEventOrdering } from "matrix-js-sdk/src/client";
import { Room } from "matrix-js-sdk/src/models/room";
import { RoomStateEvent } from "matrix-js-sdk/src/models/room-state";
import { Widget } from "matrix-widget-api";

import type { RoomMember } from "matrix-js-sdk/src/models/room-member";
import type { ClientWidgetApi } from "matrix-widget-api";
import {
    stubClient,
    mkRoomMember,
    wrapInMatrixClientContext,
    useMockedCalls,
    MockedCall,
    setupAsyncStoreWithClient,
} from "../../../test-utils";
import { MatrixClientPeg } from "../../../../src/MatrixClientPeg";
import { CallView as _CallView } from "../../../../src/components/views/voip/CallView";
import { WidgetMessagingStore } from "../../../../src/stores/widgets/WidgetMessagingStore";
import { CallStore } from "../../../../src/stores/CallStore";
import { Call, ConnectionState } from "../../../../src/models/Call";

const CallView = wrapInMatrixClientContext(_CallView);

describe("CallLobby", () => {
    useMockedCalls();
    Object.defineProperty(navigator, "mediaDevices", {
        value: {
            enumerateDevices: jest.fn(),
            getUserMedia: () => null,
        },
    });
    jest.spyOn(HTMLMediaElement.prototype, "play").mockImplementation(async () => {});

    let client: Mocked<MatrixClient>;
    let room: Room;
    let alice: RoomMember;

    beforeEach(() => {
        mocked(navigator.mediaDevices.enumerateDevices).mockResolvedValue([]);

        stubClient();
        client = mocked(MatrixClientPeg.get());

        room = new Room("!1:example.org", client, "@alice:example.org", {
            pendingEventOrdering: PendingEventOrdering.Detached,
        });
        alice = mkRoomMember(room.roomId, "@alice:example.org");
        jest.spyOn(room, "getMember").mockImplementation(userId => userId === alice.userId ? alice : null);

        client.getRoom.mockImplementation(roomId => roomId === room.roomId ? room : null);
        client.getRooms.mockReturnValue([room]);
        client.reEmitter.reEmit(room, [RoomStateEvent.Events]);

        setupAsyncStoreWithClient(CallStore.instance, client);
        setupAsyncStoreWithClient(WidgetMessagingStore.instance, client);
    });

    afterEach(() => {
        client.reEmitter.stopReEmitting(room, [RoomStateEvent.Events]);
    });

    const renderView = async (): Promise<void> => {
        render(<CallView room={room} resizing={false} waitForCall={false} />);
        await act(() => Promise.resolve()); // Let effects settle
    };

    describe("with an existing call", () => {
        let call: MockedCall;
        let widget: Widget;

        beforeEach(() => {
            MockedCall.create(room, "1");
            const maybeCall = CallStore.instance.get(room.roomId);
            if (!(maybeCall instanceof MockedCall)) throw new Error("Failed to create call");
            call = maybeCall;

            widget = new Widget(call.widget);
            WidgetMessagingStore.instance.storeMessaging(widget, room.roomId, {
                stop: () => {},
            } as unknown as ClientWidgetApi);
        });

        afterEach(() => {
            cleanup(); // Unmount before we do any cleanup that might update the component
            call.destroy();
            WidgetMessagingStore.instance.stopMessaging(widget, room.roomId);
        });

        it("calls clean on mount", async () => {
            const cleanSpy = jest.spyOn(call, "clean");
            await renderView();
            expect(cleanSpy).toHaveBeenCalled();
        });

        it("shows lobby and keeps widget loaded when disconnected", async () => {
            await renderView();
            screen.getByRole("button", { name: "Join" });
            screen.getAllByText(/\bwidget\b/i);
        });

        it("only shows widget when connected", async () => {
            await renderView();
            fireEvent.click(screen.getByRole("button", { name: "Join" }));
            await waitFor(() => expect(call.connectionState).toBe(ConnectionState.Connected));
            expect(screen.queryByRole("button", { name: "Join" })).toBe(null);
            screen.getAllByText(/\bwidget\b/i);
        });

        it("tracks participants", async () => {
            const bob = mkRoomMember(room.roomId, "@bob:example.org");
            const carol = mkRoomMember(room.roomId, "@carol:example.org");

            const expectAvatars = (userIds: string[]) => {
                const avatars = screen.queryAllByRole("button", { name: "Avatar" });
                expect(userIds.length).toBe(avatars.length);

                for (const [userId, avatar] of zip(userIds, avatars)) {
                    fireEvent.focus(avatar!);
                    screen.getByRole("tooltip", { name: userId });
                }
            };

            await renderView();
            expect(screen.queryByLabelText(/joined/)).toBe(null);
            expectAvatars([]);

            act(() => { call.participants = new Set([alice]); });
            screen.getByText("1 person joined");
            expectAvatars([alice.userId]);

            act(() => { call.participants = new Set([alice, bob, carol]); });
            screen.getByText("3 people joined");
            expectAvatars([alice.userId, bob.userId, carol.userId]);

            act(() => { call.participants = new Set(); });
            expect(screen.queryByLabelText(/joined/)).toBe(null);
            expectAvatars([]);
        });

        it("connects to the call when the join button is pressed", async () => {
            await renderView();
            const connectSpy = jest.spyOn(call, "connect");
            fireEvent.click(screen.getByRole("button", { name: "Join" }));
            await waitFor(() => expect(connectSpy).toHaveBeenCalled(), { interval: 1 });
        });
    });

    describe("without an existing call", () => {
        it("creates and connects to a new call when the join button is pressed", async () => {
            await renderView();
            expect(Call.get(room)).toBeNull();

            fireEvent.click(screen.getByRole("button", { name: "Join" }));
            await waitFor(() => expect(CallStore.instance.get(room.roomId)).not.toBeNull());
            const call = CallStore.instance.get(room.roomId)!;

            const widget = new Widget(call.widget);
            WidgetMessagingStore.instance.storeMessaging(widget, room.roomId, {
                stop: () => {},
            } as unknown as ClientWidgetApi);
            await waitFor(() => expect(call.connectionState).toBe(ConnectionState.Connected));

            cleanup(); // Unmount before we do any cleanup that might update the component
            call.destroy();
            WidgetMessagingStore.instance.stopMessaging(widget, room.roomId);
        });
    });

    describe("device buttons", () => {
        it("hide when no devices are available", async () => {
            await renderView();
            expect(screen.queryByRole("button", { name: /microphone/ })).toBe(null);
            expect(screen.queryByRole("button", { name: /camera/ })).toBe(null);
        });

        it("show without dropdown when only one device is available", async () => {
            mocked(navigator.mediaDevices.enumerateDevices).mockResolvedValue([{
                deviceId: "1",
                groupId: "1",
                label: "Webcam",
                kind: "videoinput",
                toJSON: () => {},
            }]);

            await renderView();
            screen.getByRole("button", { name: /camera/ });
            expect(screen.queryByRole("button", { name: "Video devices" })).toBe(null);
        });

        it("show with dropdown when multiple devices are available", async () => {
            mocked(navigator.mediaDevices.enumerateDevices).mockResolvedValue([
                {
                    deviceId: "1",
                    groupId: "1",
                    label: "Headphones",
                    kind: "audioinput",
                    toJSON: () => {},
                },
                {
                    deviceId: "2",
                    groupId: "1",
                    label: "", // Should fall back to "Audio input 2"
                    kind: "audioinput",
                    toJSON: () => {},
                },
            ]);

            await renderView();
            screen.getByRole("button", { name: /microphone/ });
            fireEvent.click(screen.getByRole("button", { name: "Audio devices" }));
            screen.getByRole("menuitem", { name: "Headphones" });
            screen.getByRole("menuitem", { name: "Audio input 2" });
        });
    });
});
