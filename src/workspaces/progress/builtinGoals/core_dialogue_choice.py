# core:dialogue_choice — satisfy when a specific dialogue choice id is accepted.
PlayerDialogueEvent = java_type("mchhui.rpgtoolkit.feature.talk.PlayerDialogueEvent")
ServerPlayer = java_type("net.minecraft.server.level.ServerPlayer")


@goal("core:dialogue_choice")
@config(
    field("choice", "string", required=True, hint="dialogue_choice"),
    field("node", "string", default="", hint="dialogue_node"),
)
@state(
    field("have", "int", default=0),
)
class DialogueChoiceGoal(BaseGoalPy):
    @subscribe(PlayerDialogueEvent)
    def on_dialogue(self, instance, event):
        p = event.getPlayer()
        if not instanceof(p, ServerPlayer) or not instance.isOwner(p):
            return
        if str(cfg.choice) != str(event.getChoiceId()):
            return
        if cfg.node and str(cfg.node) != str(event.getNodeId()):
            return
        st.have = 1

    def update_state(self, instance):
        self.update_satisfied_state(instance, st.have >= 1)
