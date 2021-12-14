/*
Copyright 2019-2021 The Matrix.org Foundation C.I.C.

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

import { logger } from "matrix-js-sdk/src/logger";
import { EventSubscription } from 'fbemitter';

import defaultDispatcher from '../../dispatcher/dispatcher';
import { pendingVerificationRequestForUser } from '../../verification';
import SettingsStore from "../../settings/SettingsStore";
import { RightPanelPhases } from "./RightPanelStorePhases";
import { ActionPayload } from "../../dispatcher/payloads";
import { Action } from '../../dispatcher/actions';
import { SettingLevel } from "../../settings/SettingLevel";
import { UPDATE_EVENT } from '../AsyncStore';
import { ReadyWatchingStore } from '../ReadyWatchingStore';
// import RoomViewStore from '../RoomViewStore';
import {
    IPhaseAndState,
    IPanelState,
    convertToStateRoom,
    convertToStoreRoom,
    IRightPanelForRoom,
} from './RightPanelStoreIPanelState';

const GROUP_PHASES = [
    RightPanelPhases.GroupMemberList,
    RightPanelPhases.GroupRoomList,
    RightPanelPhases.GroupRoomInfo,
    RightPanelPhases.GroupMemberInfo,
];

const MEMBER_INFO_PHASES = [
    RightPanelPhases.RoomMemberInfo,
    RightPanelPhases.Room3pidMemberInfo,
    RightPanelPhases.EncryptionPanel,
];

/**
 * A class for tracking the state of the right panel between layouts and
 * sessions. This state includes a history for each room. Each history element
 * contains the phase (e.g. RightPanelPhase.RoomMemberInfo) and the state (e.g. the
 * member) associated with it.
 * Groups are treated the same as rooms (they are also
 * stored in the byRoom object).This is possible since the store keeps track of the
 * opened room/group -> the store will provide the correct history for that
 * group/room.
*/
export default class RightPanelStore extends ReadyWatchingStore {
    private static internalInstance: RightPanelStore;
    private viewedRoomId: string;
    private isViewingRoom?: boolean;
    private dispatcherRefRightPanelStore: string;
    private roomStoreToken: EventSubscription;

    private byRoom: {
        [roomId: string]: IRightPanelForRoom;
    } = {};
    private global?: IRightPanelForRoom = null;

    private constructor() {
        super(defaultDispatcher);
        this.dispatcherRefRightPanelStore = this.dispatcher.register(this.onDispatch);
    }

    protected async onReady(): Promise<any> {
        // this.roomStoreToken = RoomViewStore.addListener(this.onRoomViewStoreUpdate);
        // TODO RightPanelStore (will be addressed in a follow up PR): This should be used instead of the onDispatch callback when groups are removed.
        this.loadCacheFromSettings();
        this.emitAndUpdateSettings();
    }

    protected async onNotReady(): Promise<any> {
        this.dispatcher.unregister(this.dispatcherRefRightPanelStore);
        // Remove RoomStore listener
        if (this.roomStoreToken) {
            this.roomStoreToken.remove();
        }
    }

    // Getters
    public get isOpenForRoom(): boolean {
        return this.byRoom[this.viewedRoomId]?.isOpen ?? false;
    }

    public get roomPhaseHistory(): Array<IPhaseAndState> {
        return this.byRoom[this.viewedRoomId]?.history ?? [];
    }

    public get currentPanel(): IPhaseAndState {
        const hist = this.roomPhaseHistory;
        if (hist.length >= 1) {
            return hist[hist.length - 1];
        }
        return { state: {}, phase: null };
    }

    public currentPanelForRoom(roomId: string): IPhaseAndState {
        const hist = this.byRoom[roomId]?.history ?? [];
        if (hist.length > 0) {
            return hist[hist.length - 1];
        }
        return this.currentPanel ?? { state: {}, phase: null };
    }

    public get previousPanel(): IPhaseAndState {
        const hist = this.roomPhaseHistory;
        if (hist?.length >= 2) {
            return hist[hist.length - 2];
        }
        return { state: {}, phase: null };
    }

    // The Group associated getters are just for backwards compatibility. Can be removed when deprecating groups.
    public get isOpenForGroup(): boolean { return this.isOpenForRoom; }
    public get groupPhaseHistory(): Array<IPhaseAndState> { return this.roomPhaseHistory; }
    public get currentGroup(): IPhaseAndState { return this.currentPanel; }
    public get previousGroup(): IPhaseAndState { return this.previousPanel; }

    // Setters
    public setRightPanel(phase: RightPanelPhases, state: IPanelState = null, allowClose = true, roomId: string = null) {
        const rId = roomId ?? this.viewedRoomId;
        // this was previously a very multifunctional command:
        // Toggle panel: if the same phase is send but without a state
        // Update state: if the same phase is send but with a state
        // Set right panel and erase history: if a "different to the current" phase is send (with or without a state)
        const redirect = this.getVerificationRedirect({ phase, state });
        const targetPhase = redirect?.phase ?? phase;
        const panelState = redirect?.state ?? state;

        // Checks for wrong SetRightPanelPhase requests
        if (!this.isPhaseActionIsValid(targetPhase)) return;

        if (targetPhase === this.currentPanel?.phase && allowClose && !panelState) {
            // Toggle panel: a toggle command needs to fullfil the following:
            // - the same phase
            // - the panel can be closed
            // - does not contain any state information (refireParams)
            this.togglePanel(rId);
            return;
        } else if ((targetPhase === this.currentPanelForRoom(rId)?.phase && !!panelState)) {
            // Update state: set right panel with a new state but keep the phase (dont know it this is ever needed...)
            const hist = this.byRoom[rId].history;
            hist[hist.length - 1].state = panelState;
            this.emitAndUpdateSettings();
            return;
        } else if (targetPhase !== this.currentPanel?.phase) {
            // Set right panel and erase history.
            this.setRightPanelCache(targetPhase, panelState);
        }
    }

    public pushRightPanel(
        phase: RightPanelPhases,
        panelState: IPanelState = null,
        allowClose = true,
        roomId: string = null,
    ) {
        const rId = roomId ?? this.viewedRoomId;
        const redirect = this.getVerificationRedirect({ phase, state: panelState });
        const targetPhase = redirect?.phase ?? phase;
        const pState = redirect?.state ?? panelState;

        // Checks for wrong SetRightPanelPhase requests
        if (!this.isPhaseActionIsValid(targetPhase)) return;

        let roomCache = this.byRoom[rId];
        if (!!roomCache) {
            // append new phase
            roomCache.history.push({ state: pState, phase: targetPhase });
            roomCache.isOpen = allowClose ? roomCache.isOpen : true;
        } else {
            // create new phase
            roomCache = {
                history: [{ phase: targetPhase, state: pState }],
                // if there was no right panel store object the the panel was closed -> keep it closed, except if allowClose==false
                isOpen: !allowClose,
            };
        }

        this.emitAndUpdateSettings();
    }

    public popRightPanel(roomId: string = null) {
        const rId = roomId ?? this.viewedRoomId;
        const roomCache = this.byRoom[rId];
        roomCache.history.pop();
        this.emitAndUpdateSettings();
    }

    public togglePanel(roomId: string = null) {
        const rId = roomId ?? this.viewedRoomId;
        this.byRoom[rId].isOpen = !this.byRoom[rId].isOpen;
        this.emitAndUpdateSettings();
    }

    // Private

    private loadCacheFromSettings() {
        const room = this.mxClient?.getRoom(this.viewedRoomId);
        if (!!room) {
            this.global = this.global ?? convertToStateRoom(SettingsStore.getValue("RightPanel.phasesGlobal"), room);
            this.byRoom[this.viewedRoomId] = this.byRoom[this.viewedRoomId] ??
                convertToStateRoom(SettingsStore.getValue("RightPanel.phases", this.viewedRoomId), room);
        }
    }

    private emitAndUpdateSettings() {
        const storePanelGlobal = convertToStoreRoom(this.global);
        const storePanelThisRoom = convertToStoreRoom(this.byRoom[this.viewedRoomId]);
        SettingsStore.setValue("RightPanel.phasesGlobal", null, SettingLevel.DEVICE, storePanelGlobal);
        if (!!this.viewedRoomId) {
            SettingsStore.setValue("RightPanel.phases",
                this.viewedRoomId,
                SettingLevel.ROOM_DEVICE,
                storePanelThisRoom,
            );
        }
        this.emit(UPDATE_EVENT, null);
    }

    private setRightPanelCache(targetPhase: RightPanelPhases, panelState: IPanelState = null) {
        // this overrides the history for the right panel in the current room.
        this.byRoom[this.viewedRoomId] = {
            history: [{ phase: targetPhase, state: panelState ?? {} }],
            isOpen: true,
        };
        this.emitAndUpdateSettings();
    }

    private getVerificationRedirect(phaseAndState: IPhaseAndState): IPhaseAndState {
        if (phaseAndState.phase === RightPanelPhases.RoomMemberInfo && phaseAndState.state) {
            // RightPanelPhases.RoomMemberInfo -> needs to be changed to RightPanelPhases.EncryptionPanel if there is a pending verification request
            const { member } = phaseAndState.state;
            const pendingRequest = pendingVerificationRequestForUser(member);
            if (pendingRequest) {
                return {
                    phase: RightPanelPhases.EncryptionPanel,
                    state: {
                        verificationRequest: pendingRequest,
                        member,
                    },
                };
            }
        }
        return null;
    }

    private isPhaseActionIsValid(targetPhase) {
        if (!RightPanelPhases[targetPhase]) {
            logger.warn(`Tried to switch right panel to unknown phase: ${targetPhase}`);
            return false;
        }
        if (GROUP_PHASES.includes(targetPhase) && this.isViewingRoom) {
            logger.warn(
                `Tried to switch right panel to a group phase: ${targetPhase}, ` +
                `but we are currently not viewing a group`,
            );
            return false;
        } else if (!GROUP_PHASES.includes(targetPhase) && !this.isViewingRoom) {
            logger.warn(
                `Tried to switch right panel to a room phase: ${targetPhase}, ` +
                `but we are currently not viewing a room`,
            );
            return false;
        }
        return true;
    }

    onRoomViewStoreUpdate() {
        // TODO: use this function instead of the onDispatch (the whole onDispatch can get removed!) as soon groups are removed
        // this.viewedRoomId = RoomViewStore.getRoomId();
        // this.isViewingRoom = true; // Is viewing room will of course be removed when removing groups
        // // load values from byRoomCache with the viewedRoomId.
        // this.loadCacheFromSettings();
    }

    onDispatch(payload: ActionPayload) {
        switch (payload.action) {
            case 'view_group':
            case Action.ViewRoom: {
                const _this = RightPanelStore.instance;
                if (payload.room_id === _this.viewedRoomId) break; // skip this transition, probably a permalink

                // Put group in the same/similar view to what was open from the previously viewed room
                // Is contradictory to the new "per room" philosophy but it is the legacy behavior for groups.
                if ((_this.isViewingRoom ? Action.ViewRoom : "view_group") != payload.action) {
                    if (payload.action == Action.ViewRoom && MEMBER_INFO_PHASES.includes(_this.currentPanel?.phase)) {
                        // switch from group to room
                        _this.setRightPanelCache(RightPanelPhases.RoomMemberList, {});
                    } else if (payload.action == "view_group"
                        && _this.currentPanel?.phase === RightPanelPhases.GroupMemberInfo) {
                        // switch from room to group
                        _this.setRightPanelCache(RightPanelPhases.GroupMemberList, {});
                    }
                }

                // Update the current room here, so that all the other functions dont need to be room dependant.
                // The right panel store always will return the state for the current room.
                _this.viewedRoomId = payload.room_id;
                _this.isViewingRoom = payload.action == Action.ViewRoom;
                // load values from byRoomCache with the viewedRoomId.
                if (!!_this.roomStoreToken) {
                    // skip loading here since we need the client to be ready to get the events form the ids of the settings
                    // this loading will be done in the onReady function
                    // all the logic in this case is not necessary anymore as soon as groups are dropped and we use: onRoomViewStoreUpdate
                    _this.loadCacheFromSettings();
                    _this.emitAndUpdateSettings();
                }
                break;
            }
        }
    }

    public static get instance(): RightPanelStore {
        if (!RightPanelStore.internalInstance) {
            RightPanelStore.internalInstance = new RightPanelStore();
        }
        return RightPanelStore.internalInstance;
    }
}

window.mxRightPanelStore = RightPanelStore.instance;