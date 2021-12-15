/*
Copyright 2019 Michael Telatynski <7t3chguy@gmail.com>
Copyright 2015 - 2021 The Matrix.org Foundation C.I.C.

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

import React from 'react';
import { Room } from "matrix-js-sdk/src/models/room";
import { RoomState } from "matrix-js-sdk/src/models/room-state";
import { RoomMember } from "matrix-js-sdk/src/models/room-member";
import { MatrixEvent } from "matrix-js-sdk/src/models/event";
import { throttle } from 'lodash';
import { User } from 'matrix-js-sdk/src/models/user';

import dis from '../../dispatcher/dispatcher';
import GroupStore from '../../stores/GroupStore';
import { RightPanelPhases } from '../../stores/right-panel/RightPanelStorePhases';
import RightPanelStore from "../../stores/right-panel/RightPanelStore";
import MatrixClientContext from "../../contexts/MatrixClientContext";
import { Action } from "../../dispatcher/actions";
import RoomSummaryCard from "../views/right_panel/RoomSummaryCard";
import WidgetCard from "../views/right_panel/WidgetCard";
import { replaceableComponent } from "../../utils/replaceableComponent";
import SettingsStore from "../../settings/SettingsStore";
import { ActionPayload } from "../../dispatcher/payloads";
import MemberList from "../views/rooms/MemberList";
import GroupMemberList from "../views/groups/GroupMemberList";
import GroupRoomList from "../views/groups/GroupRoomList";
import GroupRoomInfo from "../views/groups/GroupRoomInfo";
import UserInfo, { GroupMember } from "../views/right_panel/UserInfo";
import ThirdPartyMemberInfo from "../views/rooms/ThirdPartyMemberInfo";
import FilePanel from "./FilePanel";
import ThreadView from "./ThreadView";
import ThreadPanel from "./ThreadPanel";
import NotificationPanel from "./NotificationPanel";
import ResizeNotifier from "../../utils/ResizeNotifier";
import PinnedMessagesCard from "../views/right_panel/PinnedMessagesCard";
import { RoomPermalinkCreator } from '../../utils/permalinks/Permalinks';
import { E2EStatus } from '../../utils/ShieldUtils';
import { dispatchShowThreadsPanelEvent } from '../../dispatcher/dispatch-actions/threads';
import TimelineCard from '../views/right_panel/TimelineCard';
import { UPDATE_EVENT } from '../../stores/AsyncStore';
import { IRightPanelCard, IRightPanelCardState } from '../../stores/right-panel/RightPanelStoreIPanelState';

interface IProps {
    room?: Room; // if showing panels for a given room, this is set
    groupId?: string; // if showing panels for a given group, this is set
    overwriteCard?: IRightPanelCard; // used to display a custom card ignoring the store (for UserView)
    resizeNotifier: ResizeNotifier;
    permalinkCreator?: RoomPermalinkCreator;
    e2eStatus?: E2EStatus;
}

interface IState {
    phase: RightPanelPhases;
    isUserPrivilegedInGroup?: boolean;
    searchQuery: string;
    cardState?: IRightPanelCardState;
}

@replaceableComponent("structures.RightPanel")
export default class RightPanel extends React.Component<IProps, IState> {
    static contextType = MatrixClientContext;

    private dispatcherRef: string;

    constructor(props, context) {
        super(props, context);

        this.state = {
            // get all the state from the right panel store on init
            cardState: RightPanelStore.instance.currentCard?.state,
            phase: RightPanelStore.instance.currentCard?.phase,
            isUserPrivilegedInGroup: null,
            searchQuery: "",
        };
    }

    private readonly delayedUpdate = throttle((): void => {
        this.forceUpdate();
    }, 500, { leading: true, trailing: true });

    public componentDidMount(): void {
        this.dispatcherRef = dis.register(this.onAction);
        const cli = this.context;
        cli.on("RoomState.members", this.onRoomStateMember);
        RightPanelStore.instance.on(UPDATE_EVENT, this.onRightPanelStoreUpdate);
        this.initGroupStore(this.props.groupId);
    }

    public componentWillUnmount(): void {
        dis.unregister(this.dispatcherRef);
        if (this.context) {
            this.context.removeListener("RoomState.members", this.onRoomStateMember);
        }
        RightPanelStore.instance.off(UPDATE_EVENT, this.onRightPanelStoreUpdate);
        this.unregisterGroupStore();
    }

    // TODO: [REACT-WARNING] Replace with appropriate lifecycle event
    public UNSAFE_componentWillReceiveProps(newProps: IProps): void { // eslint-disable-line
        if (newProps.groupId !== this.props.groupId) {
            this.unregisterGroupStore();
            this.initGroupStore(newProps.groupId);
        }
    }

    private initGroupStore(groupId: string) {
        if (!groupId) return;
        GroupStore.registerListener(groupId, this.onGroupStoreUpdated);
    }

    private unregisterGroupStore() {
        GroupStore.unregisterListener(this.onGroupStoreUpdated);
    }

    private onGroupStoreUpdated = () => {
        this.setState({
            isUserPrivilegedInGroup: GroupStore.isUserPrivileged(this.props.groupId),
        });
    };

    private onRoomStateMember = (ev: MatrixEvent, state: RoomState, member: RoomMember) => {
        if (!this.props.room || member.roomId !== this.props.room.roomId) {
            return;
        }
        // redraw the badge on the membership list
        if (this.state.phase === RightPanelPhases.RoomMemberList && member.roomId === this.props.room.roomId) {
            this.delayedUpdate();
        } else if (
            this.state.phase === RightPanelPhases.RoomMemberInfo && member.roomId === this.props.room.roomId &&
            member.userId === this.state.cardState.member.userId
        ) {
            // refresh the member info (e.g. new power level)
            this.delayedUpdate();
        }
    };
    private onRightPanelStoreUpdate = () => {
        const currentPanel = RightPanelStore.instance.currentCard;
        this.setState({
            cardState: currentPanel.state,
            phase: currentPanel.phase,

        });
    };
    private onAction = (payload: ActionPayload) => {
        const isChangingRoom = payload.action === Action.ViewRoom && payload.room_id !== this.props.room.roomId;
        const isViewingThread = this.state.phase === RightPanelPhases.ThreadView;
        if (isChangingRoom && isViewingThread) {
            dispatchShowThreadsPanelEvent();
        }
    };

    private onClose = () => {
        // XXX: There are three different ways of 'closing' this panel depending on what state
        // things are in... this knows far more than it should do about the state of the rest
        // of the app and is generally a bit silly.
        if (this.props.member) {
            // If we have a user prop then we're displaying a user from the 'user' page type
            // in LoggedInView, so need to change the page type to close the panel (we switch
            // to the home page which is not obviously the correct thing to do, but I'm not sure
            // anything else is - we could hide the close button altogether?)
            dis.dispatch({
                action: "view_home_page",
            });
        } else if (
            this.state.phase === RightPanelPhases.EncryptionPanel &&
            this.state.cardState.verificationRequest && this.state.cardState.verificationRequest.pending
        ) {
            // When the user clicks close on the encryption panel cancel the pending request first if any
            this.state.cardState.verificationRequest.cancel();
        } else {
            // the RightPanelStore knows which mode room/group it is in, so we handle closing here
            RightPanelStore.instance.togglePanel();
        }
    };

    private onSearchQueryChanged = (searchQuery: string): void => {
        this.setState({ searchQuery });
    };

    public render(): JSX.Element {
        let panel = <div />;
        const roomId = this.props.room ? this.props.room.roomId : undefined;
        const phase = this.props.overwriteCard?.phase ?? this.state.phase;
        const cardState = this.props.overwriteCard?.state ?? this.state.cardState;
        switch (phase) {
            case RightPanelPhases.RoomMemberList:
                if (roomId) {
                    panel = <MemberList
                        roomId={roomId}
                        key={roomId}
                        onClose={this.onClose}
                        searchQuery={this.state.searchQuery}
                        onSearchQueryChanged={this.onSearchQueryChanged}
                    />;
                }
                break;
            case RightPanelPhases.SpaceMemberList:
                panel = <MemberList
                    roomId={cardState.space ? cardState.space.roomId : roomId}
                    key={cardState.space ? cardState.space.roomId : roomId}
                    onClose={this.onClose}
                    searchQuery={this.state.searchQuery}
                    onSearchQueryChanged={this.onSearchQueryChanged}
                />;
                break;

            case RightPanelPhases.GroupMemberList:
                if (this.props.groupId) {
                    panel = <GroupMemberList groupId={this.props.groupId} key={this.props.groupId} />;
                }
                break;

            case RightPanelPhases.GroupRoomList:
                panel = <GroupRoomList groupId={this.props.groupId} key={this.props.groupId} />;
                break;

            case RightPanelPhases.RoomMemberInfo:
            case RightPanelPhases.SpaceMemberInfo:
            case RightPanelPhases.EncryptionPanel: {
                const roomMember = cardState.member instanceof RoomMember
                    ? cardState.member
                    : undefined;
                panel = <UserInfo
                    user={cardState.member}
                    room={this.context.getRoom(roomMember?.roomId) ?? this.props.room}
                    key={roomId || cardState.member.userId}
                    onClose={this.onClose}
                    phase={phase}
                    verificationRequest={cardState.verificationRequest}
                    verificationRequestPromise={cardState.verificationRequestPromise}
                />;
                break;
            }
            case RightPanelPhases.Room3pidMemberInfo:
            case RightPanelPhases.Space3pidMemberInfo:
                panel = <ThirdPartyMemberInfo event={cardState.memberInfoEvent} key={roomId} />;
                break;

            case RightPanelPhases.GroupMemberInfo:
                panel = <UserInfo
                    user={cardState.member}
                    groupId={this.props.groupId}
                    key={cardState.member.userId}
                    phase={phase}
                    onClose={this.onClose} />;
                break;

            case RightPanelPhases.GroupRoomInfo:
                panel = <GroupRoomInfo
                    groupRoomId={cardState.groupRoomId}
                    groupId={this.props.groupId}
                    key={cardState.groupRoomId} />;
                break;

            case RightPanelPhases.NotificationPanel:
                panel = <NotificationPanel onClose={this.onClose} />;
                break;

            case RightPanelPhases.PinnedMessages:
                if (SettingsStore.getValue("feature_pinning")) {
                    panel = <PinnedMessagesCard room={this.props.room} onClose={this.onClose} />;
                }
                break;
            case RightPanelPhases.Timeline:
                if (!SettingsStore.getValue("feature_maximised_widgets")) break;
                panel = <TimelineCard
                    classNames="mx_ThreadPanel mx_TimelineCard"
                    room={this.props.room}
                    timelineSet={this.props.room.getUnfilteredTimelineSet()}
                    resizeNotifier={this.props.resizeNotifier}
                    onClose={this.onClose}
                    permalinkCreator={this.props.permalinkCreator}
                    e2eStatus={this.props.e2eStatus}
                />;
                break;
            case RightPanelPhases.FilePanel:
                panel = <FilePanel roomId={roomId} resizeNotifier={this.props.resizeNotifier} onClose={this.onClose} />;
                break;

            case RightPanelPhases.ThreadView:
                panel = <ThreadView
                    room={this.props.room}
                    resizeNotifier={this.props.resizeNotifier}
                    onClose={this.onClose}
                    mxEvent={cardState.threadHeadEvent}
                    initialEvent={cardState.initialEvent}
                    isInitialEventHighlighted={cardState.isInitialEventHighlighted}
                    permalinkCreator={this.props.permalinkCreator}
                    e2eStatus={this.props.e2eStatus} />;
                break;

            case RightPanelPhases.ThreadPanel:
                panel = <ThreadPanel
                    roomId={roomId}
                    resizeNotifier={this.props.resizeNotifier}
                    onClose={this.onClose}
                    permalinkCreator={this.props.permalinkCreator}
                />;
                break;

            case RightPanelPhases.RoomSummary:
                panel = <RoomSummaryCard room={this.props.room} onClose={this.onClose} />;
                break;

            case RightPanelPhases.Widget:
                panel = <WidgetCard
                    room={this.props.room}
                    widgetId={cardState.widgetId}
                    onClose={this.onClose} />;
                break;
        }

        return (
            <aside className="mx_RightPanel dark-panel" id="mx_RightPanel">
                { panel }
            </aside>
        );
    }
}
