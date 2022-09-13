class AIBird extends Bird {
    constructor(x, y, brain, inputs) {
        super(x, y);
        
        this.brain = brain || new NeuralNetwork([5,10,10,1]);
        this.fitness = 0;

        this.inputs = inputs;
    } 

    think(){
        /*let inputs = [];
        inputs[0] = nextPipe.bottomPipe.x1;
        inputs[1] = this.pos.y;
        inputs[2] = this.velocity;
        inputs[3] = nextPipe.bottomPipe.y1;
        inputs[4] = nextPipe.topPipe.y2;
        */

        if (this.brain == null){
            console.error("Isn't a brain neccessary to think?");
            return;
        }

        if (this.inputs == null){
            console.error("There should be a thing to think!");
        }

        if (this.inputs.length != this.brain.sizes[0]){
            console.error(`Inputs array should be 1x${this.brain.sizes[0]}.`);
            return;
        }

        let result = this.brain.feedForward(this.inputs);

        if(result[0] > 0){
            this.jump();
        }
    }

    update() {
        super.update();

        if(!this.live) return;

        this.think();
        this.fitness += frameCount;
    }

}